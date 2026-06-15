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
    
    const ccBtn = document.getElementById("voice-cc-btn");
    const transcriptPanel = document.getElementById("voice-transcript-panel");
    if (ccBtn && transcriptPanel) {
        ccBtn.addEventListener("click", () => {
            const isHidden = transcriptPanel.classList.contains("opacity-0");
            if (isHidden) {
                transcriptPanel.classList.remove("opacity-0", "translate-y-10", "pointer-events-none");
                transcriptPanel.classList.add("opacity-100", "translate-y-0", "pointer-events-auto");
                ccBtn.classList.add("bg-blue-500/20", "text-blue-600", "dark:text-blue-400");
                ccBtn.classList.remove("text-gray-700", "dark:text-gray-300");
            } else {
                transcriptPanel.classList.add("opacity-0", "translate-y-10", "pointer-events-none");
                transcriptPanel.classList.remove("opacity-100", "translate-y-0", "pointer-events-auto");
                ccBtn.classList.remove("bg-blue-500/20", "text-blue-600", "dark:text-blue-400");
                ccBtn.classList.add("text-gray-700", "dark:text-gray-300");
            }
        });
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
    const textContainer = document.getElementById("voice-transcript-panel");
    const orbContainer = document.getElementById("voice-orb-container");
    const ccBtn = document.getElementById("voice-cc-btn");
    
    // Ensure CC is off by default when opening
    if (textContainer) {
        textContainer.classList.add("opacity-0", "translate-y-10", "pointer-events-none");
        textContainer.classList.remove("opacity-100", "translate-y-0", "pointer-events-auto");
    }
    if (ccBtn) {
        ccBtn.classList.remove("bg-blue-500/20", "text-blue-600", "dark:text-blue-400");
        ccBtn.classList.add("text-gray-700", "dark:text-gray-300");
    }

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

        // Connect directly to Google Gemini Live API using v1beta
        const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${key}`;
        liveWebSocket = new WebSocket(wsUrl);
        
        liveWebSocket.onopen = () => {
            statusEl.textContent = "Listening...";
            setUIMode("listening");
            
            // Send Setup Message
            liveWebSocket.send(JSON.stringify({
                setup: {
                    // This is the correct API string for the Gemini Native Audio Dialog model
                    model: "models/gemini-2.5-flash-native-audio-latest",
                    generationConfig: {
                        responseModalities: ["AUDIO"],
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
        
        liveWebSocket.onclose = (event) => {
            console.log("Live WebSocket Closed", event.code, event.reason);
            if (event.code === 1008) {
                statusEl.textContent = "Error 1008: Invalid API Key. Please verify your Gemini API key.";
                statusEl.classList.add("text-red-500");
                setTimeout(stopLiveVoice, 4000);
            } else if (event.code !== 1000) {
                statusEl.textContent = `Connection Closed (${event.code})`;
                statusEl.classList.add("text-red-500");
                setTimeout(stopLiveVoice, 3000);
            } else {
                stopLiveVoice();
            }
        };

    } catch (error) {
        console.error("Failed to start Live Voice", error);
        if (statusEl) {
            statusEl.textContent = "Error: " + (error.message || "Failed to connect");
            statusEl.classList.add("text-red-500");
        }
        setTimeout(stopLiveVoice, 3000);
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
    if (textContainer) {
        textContainer.classList.add("translate-y-4", "opacity-0");
        textContainer.classList.remove("translate-y-0", "opacity-100");
    }
    
    overlay.classList.remove("pointer-events-auto");
    setTimeout(() => {
        overlay.classList.add("hidden");
    }, 300);

    // Sync to chat
    if (onChatSyncCallback && (userTranscript.trim() || aiTranscript.trim())) {
        onChatSyncCallback(userTranscript.trim(), aiTranscript.trim());
    }
}

function setUIMode(mode) {
    const circle = document.getElementById("voice-live-circle");
    const bgGradient = document.getElementById("voice-bg-gradient");
    const statusEl = document.getElementById("voice-live-status");
    const rings = document.querySelectorAll(".voice-wave-ring");
    
    if (!circle) return;
    
    if (mode === "speaking") {
        circle.className = "relative z-10 w-24 h-24 rounded-full bg-gradient-to-br from-purple-400 to-purple-600 dark:from-purple-500 dark:to-purple-700 flex items-center justify-center shadow-[0_0_40px_rgba(168,85,247,0.4)] transition-all duration-500";
        if (bgGradient) {
            bgGradient.className = "absolute inset-0 bg-gradient-to-br from-purple-50/50 via-white to-purple-100/50 dark:from-[#1a1124] dark:via-[#1e1f20] dark:to-purple-900/10 transition-colors duration-1000";
        }
        rings.forEach(ring => {
            ring.classList.remove("border-blue-500/30", "dark:border-blue-400/30", "border-blue-500/20", "dark:border-blue-400/20", "border-blue-500/10", "dark:border-blue-400/10");
            ring.classList.add("border-purple-500/30", "dark:border-purple-400/30");
        });
        if (statusEl) statusEl.textContent = "AI speaking...";
    } else {
        circle.className = "relative z-10 w-24 h-24 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 dark:from-blue-500 dark:to-blue-700 flex items-center justify-center shadow-[0_0_40px_rgba(59,130,246,0.4)] transition-all duration-500";
        if (bgGradient) {
            bgGradient.className = "absolute inset-0 bg-gradient-to-br from-blue-50/50 via-white to-blue-100/50 dark:from-gemini-darkBg dark:via-[#1e1f20] dark:to-blue-900/10 transition-colors duration-1000";
        }
        rings.forEach((ring, i) => {
            ring.classList.remove("border-purple-500/30", "dark:border-purple-400/30");
            if(i===0) ring.classList.add("border-blue-500/30", "dark:border-blue-400/30");
            if(i===1) ring.classList.add("border-blue-500/20", "dark:border-blue-400/20");
            if(i===2) ring.classList.add("border-blue-500/10", "dark:border-blue-400/10");
        });
        if (statusEl) statusEl.textContent = "Listening...";
    }
}

function updateWaveform(rms, source = "user") {
    const rings = document.querySelectorAll(".voice-wave-ring");
    if (!rings.length) return;
    
    const level = Math.min(1, rms * 15);
    
    rings.forEach((ring, index) => {
        // Base scale starts at 1, expands outwardly more for the outer rings
        const baseScale = 1;
        const expander = (index + 1) * 0.5 * level;
        const scale = baseScale + expander;
        const opacity = level > 0.05 ? 1 - (index * 0.2) : 0;
        
        ring.style.transform = `scale(${scale})`;
        ring.style.opacity = opacity.toString();
    });
}
