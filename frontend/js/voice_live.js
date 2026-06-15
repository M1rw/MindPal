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

    // Init wave canvas and start animation
    initWaveCanvas();
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
                    outputAudioTranscription: {},
                    systemInstruction: {
                        parts: [{
                            text: "You are MindPal, a warm and supportive AI companion for mental health. Be warm, empathetic, and conversational. Listen actively and respond thoughtfully."
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
                    // part.text = model's internal thinking. Completely ignore it.
                    // The real spoken transcript comes via outputTranscription below.

                    if (part.inlineData?.mimeType?.startsWith("audio/pcm")) {
                        applyPalette(PALETTE_SPEAK);
                        if (statusEl) statusEl.textContent = "MindPal is speaking…";

                        const audioData = atob(part.inlineData.data);
                        const pcmBuffer = new Int16Array(audioData.length / 2);
                        for (let i = 0; i < pcmBuffer.length; i++) {
                            pcmBuffer[i] = (audioData.charCodeAt(i * 2 + 1) << 8) | audioData.charCodeAt(i * 2);
                        }

                        const floatBuffer = new Float32Array(pcmBuffer.length);
                        for (let i = 0; i < pcmBuffer.length; i++) floatBuffer[i] = pcmBuffer[i] / 32768.0;

                        // Drive visualization from AI audio
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

            // outputTranscription = the actual words the model speaks (from the API)
            if (data.serverContent?.outputTranscription?.text) {
                aiTranscript += data.serverContent.outputTranscription.text;
                if (aiTextEl) aiTextEl.textContent = aiTranscript;
                scrollTranscript();
            }

            // inputTranscription = what the user said (from the API)
            if (data.serverContent?.inputTranscription?.text) {
                userTranscript += data.serverContent.inputTranscription.text;
                if (userTextEl) userTextEl.textContent = userTranscript;
                scrollTranscript();
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
        destroyWaveCanvas();
    }, 500);

    if (onChatSyncCallback && (userTranscript.trim() || aiTranscript.trim())) {
        onChatSyncCallback(userTranscript.trim(), aiTranscript.trim());
    }
}

/* ═══════════════ Wave State ═══════════════ */
let currentPalette = "listen"; // "listen" | "speak"

const WAVE_COLORS = {
    listen: [
        { r: 96, g: 165, b: 250 },   // blue-400
        { r: 129, g: 140, b: 248 },   // indigo-400
        { r: 167, g: 139, b: 250 },   // violet-400
    ],
    speak: [
        { r: 249, g: 168, b: 212 },   // pink-300
        { r: 192, g: 132, b: 252 },   // purple-400
        { r: 251, g: 191, b: 36 },    // amber-400
    ],
};

function applyPalette(p) {
    // p is PALETTE_LISTEN or PALETTE_SPEAK — we just track the mode
    currentPalette = (p === PALETTE_SPEAK) ? "speak" : "listen";
}

/* ═══════════════ Volume feeder ═══════════════ */
function feedVolume(rms) {
    smoothVolume = Math.max(smoothVolume, Math.min(1, rms * 14));
}

/* ═══════════════ Canvas Wave Renderer ═══════════════ */
let waveCanvas = null;
let waveCtx = null;

function initWaveCanvas() {
    waveCanvas = document.getElementById("voice-wave-canvas");
    if (!waveCanvas) return;
    waveCtx = waveCanvas.getContext("2d");
    resizeWaveCanvas();
    window.addEventListener("resize", resizeWaveCanvas);
}

function resizeWaveCanvas() {
    if (!waveCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    waveCanvas.width = waveCanvas.clientWidth * dpr;
    waveCanvas.height = waveCanvas.clientHeight * dpr;
    waveCtx.scale(dpr, dpr);
}

function destroyWaveCanvas() {
    window.removeEventListener("resize", resizeWaveCanvas);
    waveCanvas = null;
    waveCtx = null;
}

/* ═══════════════ Animation tick ═══════════════ */
function tick() {
    if (!isLiveSessionActive) { animFrameId = null; return; }

    blobPhase += 0.008;
    smoothVolume *= 0.92;
    if (smoothVolume < 0.003) smoothVolume = 0;

    const v = smoothVolume;

    // Draw waves on canvas
    if (waveCtx && waveCanvas) {
        const W = waveCanvas.clientWidth;
        const H = waveCanvas.clientHeight;
        waveCtx.clearRect(0, 0, W, H);

        const colors = WAVE_COLORS[currentPalette] || WAVE_COLORS.listen;
        const baseY = H * 0.65; // wave center at 65% from top
        const waveHeight = 30 + v * 80; // wave amplitude scales with volume

        // Draw 3 layered waves
        for (let layer = 0; layer < 3; layer++) {
            const c = colors[layer];
            const alpha = (0.25 + v * 0.35) * (1 - layer * 0.2);
            const freq = 0.003 + layer * 0.001;
            const speed = blobPhase * (1.2 + layer * 0.4);
            const amplitude = waveHeight * (1 - layer * 0.25);
            const yOffset = layer * 8;

            // Glow pass (wider, more transparent)
            waveCtx.beginPath();
            waveCtx.moveTo(0, H);
            for (let x = 0; x <= W; x += 2) {
                const y = baseY + yOffset
                    + Math.sin(x * freq + speed) * amplitude
                    + Math.sin(x * freq * 2.3 + speed * 0.7) * amplitude * 0.3
                    + Math.sin(x * freq * 0.5 + speed * 1.3) * amplitude * 0.5;
                waveCtx.lineTo(x, y);
            }
            waveCtx.lineTo(W, H);
            waveCtx.closePath();

            // Gradient fill from wave to bottom
            const grad = waveCtx.createLinearGradient(0, baseY - amplitude, 0, H);
            grad.addColorStop(0, `rgba(${c.r},${c.g},${c.b},${alpha})`);
            grad.addColorStop(0.4, `rgba(${c.r},${c.g},${c.b},${alpha * 0.5})`);
            grad.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0)`);
            waveCtx.fillStyle = grad;
            waveCtx.fill();
        }

        // Top glow line (bright edge of the wave)
        const mainC = colors[0];
        const glowAlpha = 0.5 + v * 0.5;
        waveCtx.beginPath();
        for (let x = 0; x <= W; x += 2) {
            const y = baseY
                + Math.sin(x * 0.003 + blobPhase * 1.2) * waveHeight
                + Math.sin(x * 0.007 + blobPhase * 0.7) * waveHeight * 0.3
                + Math.sin(x * 0.0015 + blobPhase * 1.3) * waveHeight * 0.5;
            if (x === 0) waveCtx.moveTo(x, y);
            else waveCtx.lineTo(x, y);
        }
        waveCtx.strokeStyle = `rgba(${mainC.r},${mainC.g},${mainC.b},${glowAlpha})`;
        waveCtx.lineWidth = 1.5;
        waveCtx.shadowColor = `rgba(${mainC.r},${mainC.g},${mainC.b},${glowAlpha})`;
        waveCtx.shadowBlur = 20 + v * 40;
        waveCtx.stroke();
        waveCtx.shadowBlur = 0;
    }

    // Mic dot pulse — subtle border glow, no gradient
    const micDot = document.getElementById("voice-mic-dot");
    if (micDot) {
        micDot.style.transform = `scale(${1 + v * 0.08})`;
        const borderAlpha = 0.2 + v * 0.4;
        micDot.style.borderColor = `rgba(255,255,255,${borderAlpha})`;
        micDot.style.backgroundColor = `rgba(255,255,255,${0.08 + v * 0.06})`;
    }

    // Mic ripples
    const r1 = document.getElementById("voice-mic-ripple-1");
    const r2 = document.getElementById("voice-mic-ripple-2");
    if (r1) { r1.style.transform = `scale(${1 + v * 0.25})`; r1.style.opacity = v > 0.04 ? String(0.4 * v) : "0"; }
    if (r2) { r2.style.transform = `scale(${1 + v * 0.45})`; r2.style.opacity = v > 0.04 ? String(0.2 * v) : "0"; }

    animFrameId = requestAnimationFrame(tick);
}
