// frontend/js/voice_live.js
// ─── MindPal Voice — iOS 18 Apple Intelligence style ───

let liveWebSocket = null;
let audioContext = null;
let micSource = null;
let scriptNode = null;

let isLiveSessionActive = false;
let userTranscript = "";
let aiTranscript = "";
let nextPlaybackTime = 0;

// Animation state
let animFrameId = null;
let smoothVolume = 0;     // smoothed volume 0..1
let blobPhase = 0;        // continuously incrementing phase for orbit

// Colour palettes (CSS custom properties)
const PALETTE_LISTEN = { blob1: "#22d3ee", blob2: "#3b82f6", blob3: "#6366f1", blob4: "#a855f7" };
const PALETTE_SPEAK  = { blob1: "#f472b6", blob2: "#c084fc", blob3: "#fb923c", blob4: "#e879f9" };

let onChatSyncCallback = null;

/* ───────── Init ───────── */
export function initLiveVoice({ onChatSync } = {}) {
    onChatSyncCallback = onChatSync;

    // Close buttons
    document.getElementById("voice-live-close")?.addEventListener("click", stopLiveVoice);
    document.getElementById("voice-live-close-bottom")?.addEventListener("click", stopLiveVoice);

    // CC toggle — show/hide transcript text
    const ccBtn = document.getElementById("voice-cc-toggle");
    const panel = document.getElementById("voice-transcript-panel");
    if (ccBtn && panel) {
        ccBtn.addEventListener("click", () => {
            const isVisible = panel.style.opacity !== "0";
            panel.style.opacity = isVisible ? "0" : "1";
            ccBtn.classList.toggle("bg-blue-500/20", !isVisible);
            ccBtn.classList.toggle("text-blue-500", !isVisible);
        });
    }
}

/* ───────── Start ───────── */
export async function startLiveVoice() {
    if (isLiveSessionActive) return;
    isLiveSessionActive = true;

    userTranscript = "";
    aiTranscript = "";
    nextPlaybackTime = 0;
    smoothVolume = 0;
    blobPhase = 0;

    const overlay = document.getElementById("voice-live-overlay");
    const statusEl = document.getElementById("voice-live-status");
    const userTextEl = document.getElementById("voice-live-user-text");
    const aiTextEl = document.getElementById("voice-live-ai-text");

    if (userTextEl) userTextEl.textContent = "";
    if (aiTextEl)   aiTextEl.textContent = "";
    if (statusEl)   statusEl.textContent = "Connecting…";

    // Show overlay
    overlay.classList.remove("hidden");
    void overlay.offsetWidth; // trigger reflow
    overlay.classList.remove("opacity-0");
    overlay.classList.add("pointer-events-auto");

    // Set listening colours
    applyPalette(PALETTE_LISTEN);

    // Start blob animation
    if (!animFrameId) tick();

    try {
        // Fetch API Key
        const baseUrl = window.MINDPAL_CONFIG.API_BASE_URL;
        const keyRes = await fetch(`${baseUrl}/voice/key`);
        if (!keyRes.ok) throw new Error("Failed to fetch API key");
        const { key } = await keyRes.json();

        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioContextCtor({ sampleRate: 16000 });

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micSource = audioContext.createMediaStreamSource(stream);

        // AudioWorklet for mic capture (replaces deprecated ScriptProcessorNode)
        const workletCode = `
        class PCMProcessor extends AudioWorkletProcessor {
          constructor() { super(); this.buffer = new Float32Array(4096); this.ptr = 0; }
          process(inputs) {
            const ch = inputs[0]?.[0];
            if (!ch) return true;
            for (let i = 0; i < ch.length; i++) {
              this.buffer[this.ptr++] = ch[i];
              if (this.ptr >= 4096) {
                this.port.postMessage(this.buffer);
                this.ptr = 0;
                this.buffer = new Float32Array(4096);
              }
            }
            return true;
          }
        }
        registerProcessor('pcm-processor', PCMProcessor);
        `;
        const blob = new Blob([workletCode], { type: "application/javascript" });
        const workletUrl = URL.createObjectURL(blob);
        await audioContext.audioWorklet.addModule(workletUrl);

        scriptNode = new AudioWorkletNode(audioContext, "pcm-processor");

        scriptNode.port.onmessage = (e) => {
            if (!isLiveSessionActive || !liveWebSocket || liveWebSocket.readyState !== WebSocket.OPEN) return;

            const inputData = e.data;
            const pcmData = new Int16Array(inputData.length);
            let sum = 0;
            for (let i = 0; i < inputData.length; i++) {
                const s = Math.max(-1, Math.min(1, inputData[i]));
                pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                sum += s * s;
            }

            const rms = Math.sqrt(sum / inputData.length);
            feedVolume(rms);

            const buffer = new ArrayBuffer(pcmData.length * 2);
            const view = new DataView(buffer);
            for (let i = 0; i < pcmData.length; i++) view.setInt16(i * 2, pcmData[i], true);

            let binary = "";
            const bytes = new Uint8Array(buffer);
            for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);

            liveWebSocket.send(JSON.stringify({
                realtimeInput: {
                    mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: btoa(binary) }]
                }
            }));
        };

        micSource.connect(scriptNode);
        scriptNode.connect(audioContext.destination);

        // WebSocket to Gemini Live API
        const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${key}`;
        liveWebSocket = new WebSocket(wsUrl);

        liveWebSocket.onopen = () => {
            if (statusEl) statusEl.textContent = "Listening…";
            applyPalette(PALETTE_LISTEN);

            liveWebSocket.send(JSON.stringify({
                setup: {
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
            if (event.data instanceof Blob) {
                data = JSON.parse(await event.data.text());
            } else {
                data = JSON.parse(event.data);
            }

            if (data.serverContent?.modelTurn) {
                for (const part of data.serverContent.modelTurn.parts) {
                    if (part.text) {
                        aiTranscript += part.text;
                        if (aiTextEl) aiTextEl.textContent = aiTranscript;
                        applyPalette(PALETTE_SPEAK);
                        if (statusEl) statusEl.textContent = "MindPal speaking…";
                    }
                    if (part.inlineData?.mimeType?.startsWith("audio/pcm")) {
                        const audioData = atob(part.inlineData.data);
                        const pcmBuffer = new Int16Array(audioData.length / 2);
                        for (let i = 0; i < pcmBuffer.length; i++) {
                            pcmBuffer[i] = (audioData.charCodeAt(i * 2 + 1) << 8) | audioData.charCodeAt(i * 2);
                        }

                        const floatBuffer = new Float32Array(pcmBuffer.length);
                        for (let i = 0; i < pcmBuffer.length; i++) floatBuffer[i] = pcmBuffer[i] / 32768.0;

                        // Compute AI audio level for visualisation
                        let aiSum = 0;
                        for (let i = 0; i < floatBuffer.length; i++) aiSum += floatBuffer[i] * floatBuffer[i];
                        feedVolume(Math.sqrt(aiSum / floatBuffer.length));

                        const audioBuffer = audioContext.createBuffer(1, floatBuffer.length, 24000);
                        audioBuffer.getChannelData(0).set(floatBuffer);

                        const source = audioContext.createBufferSource();
                        source.buffer = audioBuffer;
                        source.connect(audioContext.destination);

                        if (nextPlaybackTime < audioContext.currentTime) nextPlaybackTime = audioContext.currentTime;
                        source.start(nextPlaybackTime);
                        nextPlaybackTime += audioBuffer.duration;

                        source.onended = () => {
                            if (audioContext.currentTime >= nextPlaybackTime) {
                                applyPalette(PALETTE_LISTEN);
                                if (statusEl) statusEl.textContent = "Listening…";
                            }
                        };
                    }
                }
            }
        };

        liveWebSocket.onerror = (err) => {
            console.error("Live WebSocket Error", err);
            if (statusEl) statusEl.textContent = "Connection error";
            stopLiveVoice();
        };

        liveWebSocket.onclose = (event) => {
            console.log("Live WebSocket Closed", event.code, event.reason);
            if (event.code === 1008) {
                if (statusEl) statusEl.textContent = "Error: Invalid API key";
                setTimeout(stopLiveVoice, 4000);
            } else if (event.code !== 1000) {
                if (statusEl) statusEl.textContent = `Closed (${event.code})`;
                setTimeout(stopLiveVoice, 3000);
            } else {
                stopLiveVoice();
            }
        };
    } catch (error) {
        console.error("Failed to start Live Voice", error);
        if (statusEl) statusEl.textContent = "Error: " + (error.message || "Failed to connect");
        setTimeout(stopLiveVoice, 3000);
    }
}

/* ───────── Stop ───────── */
export function stopLiveVoice() {
    if (!isLiveSessionActive) return;
    isLiveSessionActive = false;

    if (scriptNode)  { scriptNode.disconnect(); scriptNode = null; }
    if (micSource)   { micSource.disconnect(); micSource = null; }
    if (audioContext && audioContext.state !== "closed") { audioContext.close(); audioContext = null; }
    if (liveWebSocket) { liveWebSocket.close(); liveWebSocket = null; }

    const overlay = document.getElementById("voice-live-overlay");
    overlay.classList.add("opacity-0");
    overlay.classList.remove("pointer-events-auto");

    setTimeout(() => {
        overlay.classList.add("hidden");
        if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
    }, 500);

    if (onChatSyncCallback && (userTranscript.trim() || aiTranscript.trim())) {
        onChatSyncCallback(userTranscript.trim(), aiTranscript.trim());
    }
}

/* ───────── Colour palette via CSS custom properties ───────── */
function applyPalette(p) {
    const overlay = document.getElementById("voice-live-overlay");
    if (!overlay) return;
    overlay.style.setProperty("--blob1", p.blob1);
    overlay.style.setProperty("--blob2", p.blob2);
    overlay.style.setProperty("--blob3", p.blob3);
    overlay.style.setProperty("--blob4", p.blob4);
}

/* ───────── Volume feeder ───────── */
function feedVolume(rms) {
    const level = Math.min(1, rms * 14);
    // Peak-hold: take the higher value to prevent jarring drops
    smoothVolume = Math.max(smoothVolume, level);
}

/* ───────── Animation tick (runs at 60fps via rAF) ───────── */
function tick() {
    if (!isLiveSessionActive) { animFrameId = null; return; }

    blobPhase += 0.008;

    // Smooth decay
    smoothVolume *= 0.92;
    if (smoothVolume < 0.005) smoothVolume = 0;

    const v = smoothVolume;

    // Move blobs — each has its own orbit pattern using sin/cos
    const b1 = document.getElementById("mp-blob-1");
    const b2 = document.getElementById("mp-blob-2");
    const b3 = document.getElementById("mp-blob-3");
    const b4 = document.getElementById("mp-blob-4");

    const baseScale = 1;
    const expand = v * 0.25; // expand inward with volume

    if (b1) {
        const x = Math.sin(blobPhase * 1.1) * 40;
        const y = Math.cos(blobPhase * 0.7) * 30;
        b1.style.transform = `translate(${x}px, ${y}px) scale(${baseScale + expand})`;
        b1.style.opacity = 0.3 + v * 0.25;
    }
    if (b2) {
        const x = Math.cos(blobPhase * 0.8) * 35;
        const y = Math.sin(blobPhase * 1.2) * 45;
        b2.style.transform = `translate(${x}px, ${y}px) scale(${baseScale + expand * 1.1})`;
        b2.style.opacity = 0.25 + v * 0.3;
    }
    if (b3) {
        const x = Math.sin(blobPhase * 0.6) * 50;
        const y = Math.cos(blobPhase * 0.9) * 35;
        b3.style.transform = `translate(${x}px, ${y}px) scale(${baseScale + expand * 0.9})`;
        b3.style.opacity = 0.25 + v * 0.2;
    }
    if (b4) {
        const x = Math.cos(blobPhase * 1.3) * 30;
        const y = Math.sin(blobPhase * 0.5) * 40;
        b4.style.transform = `translate(${x}px, ${y}px) scale(${baseScale + expand * 1.2})`;
        b4.style.opacity = 0.2 + v * 0.25;
    }

    // Mic dot pulse
    const micDot = document.getElementById("voice-mic-dot");
    if (micDot) {
        const micScale = 1 + v * 0.15;
        micDot.style.transform = `scale(${micScale})`;
        micDot.style.boxShadow = `0 0 ${30 + v * 40}px rgba(59,130,246,${0.3 + v * 0.3})`;
    }

    // Mic ripples
    const r1 = document.getElementById("voice-mic-ripple-1");
    const r2 = document.getElementById("voice-mic-ripple-2");
    if (r1) { r1.style.transform = `scale(${1 + v * 0.4})`; r1.style.opacity = v > 0.05 ? (0.6 * v) : 0; }
    if (r2) { r2.style.transform = `scale(${1 + v * 0.7})`; r2.style.opacity = v > 0.05 ? (0.3 * v) : 0; }

    animFrameId = requestAnimationFrame(tick);
}
