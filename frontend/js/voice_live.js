// frontend/js/voice_live.js
// ─── MindPal Voice — real-time voice with Gemini Live ───

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
let smoothVolume = 0;
let blobPhase = 0;

// Colour palettes (CSS custom properties on the overlay)
const PALETTE_LISTEN = { blob1: "#60a5fa", blob2: "#818cf8", blob3: "#a78bfa", blob4: "#c4b5fd" };
const PALETTE_SPEAK  = { blob1: "#f9a8d4", blob2: "#c084fc", blob3: "#fbbf24", blob4: "#e879f9" };

let onChatSyncCallback = null;
let ccVisible = true;

/* ═══════════════ Helpers ═══════════════ */

/** Strip the model's internal thinking/reasoning markers from displayed text.
 *  Gemini Native Audio returns cognitive monologue as text — we only want
 *  the words the model actually *speaks* to the user. */
function cleanAiText(raw) {
    return raw
        // Remove **bold markers** like "**Acknowledge Greeting**"
        .replace(/\*\*[^*]+\*\*/g, "")
        // Remove lines that are clearly internal reasoning
        .replace(/^.*?\b(I can certainly|I'll respond|I'm processing|I am processing|I will|I am prioritizing|To continue|meaning I|reciprocate|optimal function|inform our|overture|cordially|I'll pose|straightforward)\b.*$/gim, "")
        // Remove any remaining lines that start with "I " followed by cognitive verbs
        .replace(/^I\s+(understand|need to|should|must|recognize|notice|sense|perceive|detect|observe|acknowledge|am going to|want to|plan to)\b.*$/gim, "")
        // Collapse leftover whitespace
        .replace(/\n{2,}/g, "\n")
        .trim();
}

function scrollTranscript() {
    const panel = document.getElementById("voice-transcript-panel");
    if (panel) panel.scrollTop = panel.scrollHeight;
}

/* ═══════════════ Init ═══════════════ */
export function initLiveVoice({ onChatSync } = {}) {
    onChatSyncCallback = onChatSync;

    document.getElementById("voice-live-close")?.addEventListener("click", stopLiveVoice);
    document.getElementById("voice-live-close-bottom")?.addEventListener("click", stopLiveVoice);

    // CC toggle — show/hide transcript
    const ccBtn = document.getElementById("voice-cc-toggle");
    if (ccBtn) {
        ccBtn.addEventListener("click", () => {
            ccVisible = !ccVisible;
            const panel = document.getElementById("voice-transcript-panel");
            if (panel) panel.style.opacity = ccVisible ? "1" : "0";
            ccBtn.classList.toggle("bg-blue-500/15", ccVisible);
        });
    }
}

/* ═══════════════ Start ═══════════════ */
export async function startLiveVoice() {
    if (isLiveSessionActive) return;
    isLiveSessionActive = true;

    userTranscript = "";
    aiTranscript = "";
    nextPlaybackTime = 0;
    smoothVolume = 0;
    blobPhase = 0;
    ccVisible = true;

    const overlay = document.getElementById("voice-live-overlay");
    const statusEl = document.getElementById("voice-live-status");
    const userTextEl = document.getElementById("voice-live-user-text");
    const aiTextEl = document.getElementById("voice-live-ai-text");
    const panel = document.getElementById("voice-transcript-panel");

    if (userTextEl) userTextEl.textContent = "";
    if (aiTextEl)   aiTextEl.textContent = "";
    if (statusEl)   statusEl.textContent = "Connecting…";
    if (panel) panel.style.opacity = "1";

    // Reset CC toggle visual
    const ccBtn = document.getElementById("voice-cc-toggle");
    if (ccBtn) ccBtn.classList.add("bg-blue-500/15");

    // Show overlay
    overlay.classList.remove("hidden");
    void overlay.offsetWidth;
    overlay.classList.remove("opacity-0");
    overlay.classList.add("pointer-events-auto");

    // Set listening colours
    applyPalette(PALETTE_LISTEN);

    // Start animation
    if (!animFrameId) tick();

    try {
        const baseUrl = window.MINDPAL_CONFIG.API_BASE_URL;
        const keyRes = await fetch(`${baseUrl}/voice/key`);
        if (!keyRes.ok) throw new Error("Failed to fetch API key");
        const { key } = await keyRes.json();

        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioContextCtor({ sampleRate: 16000 });

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micSource = audioContext.createMediaStreamSource(stream);

        // AudioWorklet
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
        await audioContext.audioWorklet.addModule(URL.createObjectURL(blob));

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

            feedVolume(Math.sqrt(sum / inputData.length));

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

        // WebSocket
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
                    },
                    systemInstruction: {
                        parts: [{
                            text: "You are MindPal, a warm and supportive AI companion. Speak naturally and conversationally. IMPORTANT: Any text you return must be ONLY the exact words you speak aloud. Do NOT include internal reasoning, cognitive notes, thinking steps, or meta-commentary about what you are doing. Never start sentences with 'I am processing' or 'I will respond' or similar."
                        }]
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
                        if (aiTextEl) aiTextEl.textContent = cleanAiText(aiTranscript);
                        applyPalette(PALETTE_SPEAK);
                        if (statusEl) statusEl.textContent = "MindPal is speaking…";
                        scrollTranscript();
                    }
                    if (part.inlineData?.mimeType?.startsWith("audio/pcm")) {
                        const audioData = atob(part.inlineData.data);
                        const pcmBuffer = new Int16Array(audioData.length / 2);
                        for (let i = 0; i < pcmBuffer.length; i++) {
                            pcmBuffer[i] = (audioData.charCodeAt(i * 2 + 1) << 8) | audioData.charCodeAt(i * 2);
                        }

                        const floatBuffer = new Float32Array(pcmBuffer.length);
                        for (let i = 0; i < pcmBuffer.length; i++) floatBuffer[i] = pcmBuffer[i] / 32768.0;

                        // Drive visualization from AI audio too
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

/* ═══════════════ Stop ═══════════════ */
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

/* ═══════════════ Palette ═══════════════ */
function applyPalette(p) {
    const overlay = document.getElementById("voice-live-overlay");
    if (!overlay) return;
    overlay.style.setProperty("--blob1", p.blob1);
    overlay.style.setProperty("--blob2", p.blob2);
    overlay.style.setProperty("--blob3", p.blob3);
    overlay.style.setProperty("--blob4", p.blob4);
}

/* ═══════════════ Volume feeder ═══════════════ */
function feedVolume(rms) {
    smoothVolume = Math.max(smoothVolume, Math.min(1, rms * 14));
}

/* ═══════════════ Animation tick ═══════════════ */
function tick() {
    if (!isLiveSessionActive) { animFrameId = null; return; }

    blobPhase += 0.006;
    smoothVolume *= 0.93;
    if (smoothVolume < 0.003) smoothVolume = 0;

    const v = smoothVolume;

    // Move blobs — gentle sine orbit at edges
    const b1 = document.getElementById("mp-blob-1");
    const b2 = document.getElementById("mp-blob-2");
    const b3 = document.getElementById("mp-blob-3");
    const b4 = document.getElementById("mp-blob-4");

    const expand = v * 0.2;

    if (b1) {
        b1.style.transform = `translate(${Math.sin(blobPhase * 1.1) * 30}px, ${Math.cos(blobPhase * 0.7) * 25}px) scale(${1 + expand})`;
        b1.style.opacity = 0.15 + v * 0.15;
    }
    if (b2) {
        b2.style.transform = `translate(${Math.cos(blobPhase * 0.8) * 25}px, ${Math.sin(blobPhase * 1.2) * 35}px) scale(${1 + expand * 1.1})`;
        b2.style.opacity = 0.12 + v * 0.18;
    }
    if (b3) {
        b3.style.transform = `translate(${Math.sin(blobPhase * 0.6) * 40}px, ${Math.cos(blobPhase * 0.9) * 28}px) scale(${1 + expand * 0.9})`;
        b3.style.opacity = 0.12 + v * 0.12;
    }
    if (b4) {
        b4.style.transform = `translate(${Math.cos(blobPhase * 1.3) * 22}px, ${Math.sin(blobPhase * 0.5) * 32}px) scale(${1 + expand * 1.2})`;
        b4.style.opacity = 0.1 + v * 0.15;
    }

    // Mic dot pulse
    const micDot = document.getElementById("voice-mic-dot");
    if (micDot) {
        micDot.style.transform = `scale(${1 + v * 0.12})`;
        micDot.style.boxShadow = `0 0 ${22 + v * 35}px rgba(59,130,246,${0.25 + v * 0.25})`;
    }

    // Mic ripples
    const r1 = document.getElementById("voice-mic-ripple-1");
    const r2 = document.getElementById("voice-mic-ripple-2");
    if (r1) { r1.style.transform = `scale(${1 + v * 0.35})`; r1.style.opacity = v > 0.04 ? String(0.5 * v) : "0"; }
    if (r2) { r2.style.transform = `scale(${1 + v * 0.6})`; r2.style.opacity = v > 0.04 ? String(0.25 * v) : "0"; }

    animFrameId = requestAnimationFrame(tick);
}
