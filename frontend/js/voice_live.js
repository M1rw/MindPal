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

let blobAngles = [0, 120, 240];
let blobAnimationFrame = null;
let currentVolumeLevel = 0;

// Connect to Chat UI to append messages
let onChatSyncCallback = null;

export function initLiveVoice({ onChatSync } = {}) {
    onChatSyncCallback = onChatSync;
    
    const closeBtn = document.getElementById("voice-live-close");
    const closeBottomBtn = document.getElementById("voice-live-close-bottom");
    if (closeBtn) closeBtn.addEventListener("click", stopLiveVoice);
    if (closeBottomBtn) closeBottomBtn.addEventListener("click", stopLiveVoice);
    
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

    // Start MindPal Fluid Edge Engine
    currentVolumeLevel = 0;
    if (!blobAnimationFrame) {
        animateBlobs();
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
    const transcriptPanel = document.getElementById("voice-transcript-panel");
    const orbContainer = document.getElementById("voice-orb-container");
    
    overlay.classList.add("opacity-0");
    if (transcriptPanel) {
        transcriptPanel.classList.add("translate-y-10", "opacity-0", "pointer-events-none");
        transcriptPanel.classList.remove("translate-y-0", "opacity-100", "pointer-events-auto");
    }
    
    overlay.classList.remove("pointer-events-auto");
    setTimeout(() => {
        overlay.classList.add("hidden");
        if (blobAnimationFrame) {
            cancelAnimationFrame(blobAnimationFrame);
            blobAnimationFrame = null;
        }
    }, 300);

    // Sync to chat
    if (onChatSyncCallback && (userTranscript.trim() || aiTranscript.trim())) {
        onChatSyncCallback(userTranscript.trim(), aiTranscript.trim());
    }
}

function setUIMode(mode) {
    const ccBtn = document.getElementById("voice-cc-btn");
    const statusEl = document.getElementById("voice-live-status");
    
    // MindPal Edge Blobs
    const b1 = document.getElementById("mindpal-blob-1");
    const b2 = document.getElementById("mindpal-blob-2");
    const b3 = document.getElementById("mindpal-blob-3");
    
    if (mode === "speaking") {
        if (b1) b1.className = "absolute -top-[10%] -left-[10%] w-[50vw] h-[50vw] max-w-[500px] max-h-[500px] rounded-full mix-blend-multiply dark:mix-blend-screen filter blur-[100px] opacity-80 transition-colors duration-1000 ease-out bg-purple-500/50 dark:bg-purple-600/50";
        if (b2) b2.className = "absolute top-[30%] -right-[10%] w-[45vw] h-[45vw] max-w-[450px] max-h-[450px] rounded-full mix-blend-multiply dark:mix-blend-screen filter blur-[100px] opacity-80 transition-colors duration-1000 ease-out bg-magenta-500/50 dark:bg-pink-500/50";
        if (b3) b3.className = "absolute -bottom-[10%] left-[20%] w-[60vw] h-[60vw] max-w-[600px] max-h-[600px] rounded-full mix-blend-multiply dark:mix-blend-screen filter blur-[120px] opacity-70 transition-colors duration-1000 ease-out bg-orange-400/40 dark:bg-red-500/40";
        
        if (ccBtn) {
            ccBtn.className = "relative z-10 w-20 h-20 flex items-center justify-center rounded-full bg-[#9333ea] shadow-[0_8px_30px_rgba(147,51,234,0.4)] text-white transition-transform hover:scale-105 active:scale-95";
        }
        if (statusEl) statusEl.textContent = "AI speaking...";
    } else {
        if (b1) b1.className = "absolute -top-[10%] -left-[10%] w-[50vw] h-[50vw] max-w-[500px] max-h-[500px] rounded-full mix-blend-multiply dark:mix-blend-screen filter blur-[100px] opacity-70 transition-colors duration-1000 ease-out bg-cyan-400/50 dark:bg-cyan-500/50";
        if (b2) b2.className = "absolute top-[30%] -right-[10%] w-[45vw] h-[45vw] max-w-[450px] max-h-[450px] rounded-full mix-blend-multiply dark:mix-blend-screen filter blur-[100px] opacity-70 transition-colors duration-1000 ease-out bg-blue-500/50 dark:bg-blue-600/50";
        if (b3) b3.className = "absolute -bottom-[10%] left-[20%] w-[60vw] h-[60vw] max-w-[600px] max-h-[600px] rounded-full mix-blend-multiply dark:mix-blend-screen filter blur-[120px] opacity-60 transition-colors duration-1000 ease-out bg-indigo-500/40 dark:bg-purple-600/40";

        if (ccBtn) {
            ccBtn.className = "relative z-10 w-20 h-20 flex items-center justify-center rounded-full bg-[#1b73e8] shadow-[0_8px_30px_rgba(27,115,232,0.4)] text-white transition-transform hover:scale-105 active:scale-95";
        }
        if (statusEl) statusEl.textContent = "Listening...";
    }
}

function animateBlobs() {
    if (!isLiveSessionActive) return;
    
    // Slow resting orbit speeds
    const speedMultiplier = 1 + (currentVolumeLevel * 2);
    blobAngles[0] += 0.1 * speedMultiplier;
    blobAngles[1] -= 0.15 * speedMultiplier;
    blobAngles[2] += 0.12 * speedMultiplier;

    const b1 = document.getElementById("mindpal-blob-1");
    const b2 = document.getElementById("mindpal-blob-2");
    const b3 = document.getElementById("mindpal-blob-3");
    
    // Smooth volume decay to 0
    currentVolumeLevel = Math.max(0, currentVolumeLevel - 0.03);
    
    // Base scale is 1, expands outward with volume
    const scale = 1 + (currentVolumeLevel * 0.35);

    if (b1) b1.style.transform = `scale(${scale}) rotate(${blobAngles[0]}deg) translateX(30px)`;
    if (b2) b2.style.transform = `scale(${scale * 1.1}) rotate(${blobAngles[1]}deg) translateY(40px)`;
    if (b3) b3.style.transform = `scale(${scale * 0.9}) rotate(${blobAngles[2]}deg) translateX(-30px)`;
    
    blobAnimationFrame = requestAnimationFrame(animateBlobs);
}

function updateWaveform(rms, source = "user") {
    const level = Math.min(1, rms * 15);
    
    // Update the Blob engine volume (take the peak to prevent jagged drops)
    currentVolumeLevel = Math.max(currentVolumeLevel, level);
    
    // Animate Mic Button ripples
    const micRipple1 = document.getElementById("voice-mic-ripple-1");
    const micRipple2 = document.getElementById("voice-mic-ripple-2");
    
    if (micRipple1 && micRipple2) {
        const expanded1 = 1 + (level * 0.5);
        const expanded2 = 1 + (level * 0.8);
        
        micRipple1.style.transform = `scale(${expanded1})`;
        micRipple1.style.opacity = level > 0.05 ? 1 : 0;
        
        micRipple2.style.transform = `scale(${expanded2})`;
        micRipple2.style.opacity = level > 0.05 ? 0.6 : 0;
    }
}
