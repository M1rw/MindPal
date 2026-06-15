// frontend/js/voice_live.js

let liveWebSocket = null;
let audioContext = null;
let micSource = null;
let scriptNode = null;
let playbackNode = null;

let isLiveSessionActive = false;
let userAudioQueue = [];
let aiAudioQueue = [];

let userTranscript = "";
let aiTranscript = "";
let nextPlaybackTime = 0;

// Connect to Chat UI to append messages
let onChatSyncCallback = null;

export function initLiveVoice({ onChatSync } = {}) {
    onChatSyncCallback = onChatSync;
    
    const closeBtn = document.getElementById("voice-live-close");
    if (closeBtn) {
        closeBtn.addEventListener("click", stopLiveVoice);
    }
}

export async function startLiveVoice() {
    if (isLiveSessionActive) return;
    
    isLiveSessionActive = true;
    userTranscript = "";
    aiTranscript = "";
    userAudioQueue = [];
    aiAudioQueue = [];
    nextPlaybackTime = 0;

    const overlay = document.getElementById("voice-live-overlay");
    const statusEl = document.getElementById("voice-live-status");
    const userTextEl = document.getElementById("voice-live-user-text");
    const aiTextEl = document.getElementById("voice-live-ai-text");
    
    userTextEl.textContent = "";
    aiTextEl.textContent = "";
    statusEl.textContent = "Connecting to Gemini Live...";
    
    overlay.classList.remove("hidden");
    // Trigger reflow
    void overlay.offsetWidth;
    overlay.classList.remove("opacity-0");
    overlay.classList.add("pointer-events-auto");

    try {
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioContextCtor({ sampleRate: 16000 });
        
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micSource = audioContext.createMediaStreamSource(stream);
        
        // Use ScriptProcessor for raw PCM capture
        scriptNode = audioContext.createScriptProcessor(4096, 1, 1);
        
        scriptNode.onaudioprocess = (audioProcessingEvent) => {
            if (!isLiveSessionActive || !liveWebSocket || liveWebSocket.readyState !== WebSocket.OPEN) return;
            
            const inputBuffer = audioProcessingEvent.inputBuffer;
            const inputData = inputBuffer.getChannelData(0);
            
            // Convert Float32 to Int16
            const pcmData = new Int16Array(inputData.length);
            let sum = 0;
            for (let i = 0; i < inputData.length; i++) {
                let s = Math.max(-1, Math.min(1, inputData[i]));
                pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                sum += s * s;
            }
            
            // UI Waveform update (simple RMS)
            const rms = Math.sqrt(sum / inputData.length);
            updateWaveform(rms, "user");

            // Convert to Base64
            const buffer = new ArrayBuffer(pcmData.length * 2);
            const view = new DataView(buffer);
            for (let i = 0; i < pcmData.length; i++) {
                view.setInt16(i * 2, pcmData[i], true); // little endian
            }
            
            let binary = '';
            const bytes = new Uint8Array(buffer);
            for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            const base64Data = btoa(binary);
            
            liveWebSocket.send(JSON.stringify({
                realtimeInput: {
                    data: base64Data
                }
            }));
        };

        micSource.connect(scriptNode);
        scriptNode.connect(audioContext.destination);

        // Connect WebSocket
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = `${protocol}//${window.location.host}/api/voice/live`;
        
        liveWebSocket = new WebSocket(wsUrl);
        
        liveWebSocket.onopen = () => {
            statusEl.textContent = "Listening...";
            setUIMode("listening");
        };
        
        liveWebSocket.onmessage = async (event) => {
            const response = JSON.parse(event.data);
            
            if (response.serverContent && response.serverContent.modelTurn) {
                const parts = response.serverContent.modelTurn.parts;
                for (const part of parts) {
                    if (part.text) {
                        aiTranscript += part.text;
                        aiTextEl.textContent = aiTranscript;
                        setUIMode("speaking");
                    }
                    if (part.inlineData && part.inlineData.mimeType.startsWith("audio/pcm")) {
                        // Play back audio
                        const audioData = atob(part.inlineData.data);
                        const pcmBuffer = new Int16Array(audioData.length / 2);
                        for (let i = 0; i < pcmBuffer.length; i++) {
                            const byteA = audioData.charCodeAt(i * 2);
                            const byteB = audioData.charCodeAt(i * 2 + 1);
                            pcmBuffer[i] = (byteB << 8) | byteA;
                        }
                        
                        const floatBuffer = new Float32Array(pcmBuffer.length);
                        for (let i = 0; i < pcmBuffer.length; i++) {
                            floatBuffer[i] = pcmBuffer[i] / 32768.0;
                        }
                        
                        const audioBuffer = audioContext.createBuffer(1, floatBuffer.length, 24000); // Gemini returns 24kHz
                        audioBuffer.getChannelData(0).set(floatBuffer);
                        
                        const source = audioContext.createBufferSource();
                        source.buffer = audioBuffer;
                        source.connect(audioContext.destination);
                        
                        if (nextPlaybackTime < audioContext.currentTime) {
                            nextPlaybackTime = audioContext.currentTime;
                        }
                        source.start(nextPlaybackTime);
                        nextPlaybackTime += audioBuffer.duration;
                        
                        // Fake AI waveform based on playback
                        source.onended = () => {
                            if (audioContext.currentTime >= nextPlaybackTime) {
                                setUIMode("listening");
                            }
                        };
                    }
                }
            }
        };
        
        liveWebSocket.onerror = (err) => {
            console.error("Live WebSocket Error", err);
            statusEl.textContent = "Connection Error";
            stopLiveVoice();
        };
        
        liveWebSocket.onclose = () => {
            stopLiveVoice();
        };

    } catch (error) {
        console.error("Failed to start Live Voice", error);
        statusEl.textContent = "Error Accessing Microphone";
        setTimeout(stopLiveVoice, 2000);
    }
}

export function stopLiveVoice() {
    if (!isLiveSessionActive) return;
    isLiveSessionActive = false;
    
    if (scriptNode) {
        scriptNode.disconnect();
        scriptNode = null;
    }
    if (micSource) {
        micSource.disconnect();
        micSource = null;
    }
    if (audioContext && audioContext.state !== "closed") {
        audioContext.close();
        audioContext = null;
    }
    if (liveWebSocket) {
        liveWebSocket.close();
        liveWebSocket = null;
    }
    
    const overlay = document.getElementById("voice-live-overlay");
    overlay.classList.add("opacity-0");
    overlay.classList.remove("pointer-events-auto");
    setTimeout(() => {
        overlay.classList.add("hidden");
    }, 500);

    // Sync to chat
    if (onChatSyncCallback && (userTranscript.trim() || aiTranscript.trim())) {
        onChatSyncCallback(userTranscript.trim(), aiTranscript.trim());
    }
}

function setUIMode(mode) {
    const ring = document.getElementById("voice-live-ring");
    const glow = document.getElementById("voice-live-glow");
    const icon = document.getElementById("voice-live-icon");
    const statusEl = document.getElementById("voice-live-status");
    
    if (mode === "speaking") {
        ring.setAttribute("stroke", "rgba(168,85,247,0.8)");
        glow.className = "absolute inset-0 rounded-full bg-purple-500/30 blur-3xl transition-all duration-300";
        icon.className = "w-16 h-16 text-purple-300 drop-shadow-md transition-colors duration-300";
        statusEl.textContent = "AI is speaking...";
    } else {
        ring.setAttribute("stroke", "rgba(34,211,238,0.5)");
        glow.className = "absolute inset-0 rounded-full bg-cyan-500/20 blur-3xl transition-all duration-300";
        icon.className = "w-16 h-16 text-cyan-300 drop-shadow-md transition-colors duration-300";
        statusEl.textContent = "Listening...";
    }
}

function updateWaveform(rms, source = "user") {
    // scale dashoffset based on rms
    const ring = document.getElementById("voice-live-ring");
    if (!ring) return;
    
    const circumference = 628;
    const level = Math.min(1, rms * 15);
    const offset = circumference - (level * circumference);
    ring.setAttribute("stroke-dashoffset", offset.toString());
}
