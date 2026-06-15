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
    
    // Animate elements in
    const textContainer = document.getElementById("voice-text-container");
    const orbContainer = document.getElementById("voice-orb-container");
    setTimeout(() => {
        textContainer.classList.remove("translate-y-4", "opacity-0");
        textContainer.classList.add("translate-y-0", "opacity-100");
        orbContainer.classList.remove("scale-90");
        orbContainer.classList.add("scale-100");
    }, 50);

    try {
        // Fetch API Key directly
        const baseUrl = window.MINDPAL_CONFIG.API_BASE_URL;
        const keyRes = await fetch(`${baseUrl}/voice/key`);
        if (!keyRes.ok) throw new Error("Failed to fetch API key");
        const { key } = await keyRes.json();

        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioContextCtor({ sampleRate: 16000 });
        
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micSource = audioContext.createMediaStreamSource(stream);
        
        // Use modern AudioWorklet instead of deprecated ScriptProcessorNode
        const workletCode = `
        class PCMProcessor extends AudioWorkletProcessor {
          constructor() {
            super();
            this.buffer = new Float32Array(4096);
            this.ptr = 0;
          }
          process(inputs, outputs, parameters) {
            const input = inputs[0];
            if (input && input.length > 0 && input[0]) {
              const channelData = input[0];
              for(let i=0; i<channelData.length; i++) {
                this.buffer[this.ptr++] = channelData[i];
                if(this.ptr >= 4096) {
                    this.port.postMessage(this.buffer);
                    this.ptr = 0;
                    this.buffer = new Float32Array(4096);
                }
              }
            }
            return true;
          }
        }
        registerProcessor('pcm-processor', PCMProcessor);
        `;
        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const workletUrl = URL.createObjectURL(blob);
        await audioContext.audioWorklet.addModule(workletUrl);
        
        scriptNode = new AudioWorkletNode(audioContext, 'pcm-processor');
        
        scriptNode.port.onmessage = (e) => {
            if (!isLiveSessionActive || !liveWebSocket || liveWebSocket.readyState !== WebSocket.OPEN) return;
            
            const inputData = e.data; // Float32Array
            const pcmData = new Int16Array(inputData.length);
            let sum = 0;
            for (let i = 0; i < inputData.length; i++) {
                let s = Math.max(-1, Math.min(1, inputData[i]));
                pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                sum += s * s;
            }
            
            const rms = Math.sqrt(sum / inputData.length);
            updateWaveform(rms, "user");

            const buffer = new ArrayBuffer(pcmData.length * 2);
            const view = new DataView(buffer);
            for (let i = 0; i < pcmData.length; i++) {
                view.setInt16(i * 2, pcmData[i], true);
            }
            
            let binary = '';
            const bytes = new Uint8Array(buffer);
            for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            const base64Data = btoa(binary);
            
            liveWebSocket.send(JSON.stringify({
                realtimeInput: {
                    mediaChunks: [{
                        mimeType: "audio/pcm;rate=16000",
                        data: base64Data
                    }]
                }
            }));
        };

        micSource.connect(scriptNode);
        scriptNode.connect(audioContext.destination);

        // Connect directly to Google Gemini Live API
        const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${key}`;
        liveWebSocket = new WebSocket(wsUrl);
        
        liveWebSocket.onopen = () => {
            statusEl.textContent = "Listening...";
            setUIMode("listening");
            
            // Send Setup Message
            liveWebSocket.send(JSON.stringify({
                setup: {
                    model: "models/gemini-2.0-flash-exp",
                    generationConfig: {
                        responseModalities: ["AUDIO", "TEXT"],
                        speechConfig: {
                            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } }
                        }
                    }
                }
            }));
        };
        
        liveWebSocket.onmessage = async (event) => {
            let data;
            // Handle binary payload or JSON text
            if (event.data instanceof Blob) {
                const text = await event.data.text();
                data = JSON.parse(text);
            } else {
                data = JSON.parse(event.data);
            }
            
            const response = data;
            
            if (response.serverContent && response.serverContent.modelTurn) {
                const parts = response.serverContent.modelTurn.parts;
                for (const part of parts) {
                    if (part.text) {
                        aiTranscript += part.text;
                        aiTextEl.textContent = aiTranscript;
                        setUIMode("speaking");
                    }
                    if (part.inlineData && part.inlineData.mimeType.startsWith("audio/pcm")) {
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
                        
                        // Gemini Live API returns 24kHz audio
                        const audioBuffer = audioContext.createBuffer(1, floatBuffer.length, 24000); 
                        audioBuffer.getChannelData(0).set(floatBuffer);
                        
                        const source = audioContext.createBufferSource();
                        source.buffer = audioBuffer;
                        source.connect(audioContext.destination);
                        
                        if (nextPlaybackTime < audioContext.currentTime) {
                            nextPlaybackTime = audioContext.currentTime;
                        }
                        source.start(nextPlaybackTime);
                        nextPlaybackTime += audioBuffer.duration;
                        
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
    const textContainer = document.getElementById("voice-text-container");
    const orbContainer = document.getElementById("voice-orb-container");
    
    overlay.classList.add("opacity-0");
    textContainer.classList.add("translate-y-4", "opacity-0");
    textContainer.classList.remove("translate-y-0", "opacity-100");
    orbContainer.classList.add("scale-90");
    orbContainer.classList.remove("scale-100");
    
    overlay.classList.remove("pointer-events-auto");
    setTimeout(() => {
        overlay.classList.add("hidden");
    }, 700);

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
        ringOuter.setAttribute("stroke", "rgba(168,85,247,0.2)");
        glow.className = "absolute inset-0 rounded-full bg-purple-500/30 blur-[60px] transition-all duration-700 scale-110";
        icon.className = "w-12 h-12 text-purple-300 drop-shadow-[0_0_20px_rgba(168,85,247,0.6)] transition-colors duration-500";
        statusEl.textContent = "AI SPEAKING...";
    } else {
        ring.setAttribute("stroke", "rgba(34,211,238,0.8)");
        ringOuter.setAttribute("stroke", "rgba(34,211,238,0.1)");
        glow.className = "absolute inset-0 rounded-full bg-cyan-400/20 blur-[60px] transition-all duration-700 scale-100";
        icon.className = "w-12 h-12 text-cyan-200/90 drop-shadow-[0_0_15px_rgba(34,211,238,0.5)] transition-colors duration-500";
        statusEl.textContent = "LISTENING...";
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
    
    const ringOuter = document.getElementById("voice-live-ring-outer");
    if (ringOuter) {
        const outerCircumference = 722;
        const outerOffset = outerCircumference - (level * outerCircumference * 1.5);
        ringOuter.setAttribute("stroke-dashoffset", outerOffset.toString());
    }
}
