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

// Mic mute state
let isMicMuted = false;

// Track active audio sources for barge-in
let activeAudioSources = [];
let isAiSpeaking = false;

// AnalyserNode for real frequency visualizer
let analyser = null;
let freqData = null;
let smoothBins = null;
const BIN_COUNT = 64;

// Colour palettes (used to differentiate listen vs speak state)
const PALETTE_LISTEN = { id: "listen" };
const PALETTE_SPEAK  = { id: "speak" };

let onChatSyncCallback = null;
let ccVisible = true;

/* ═══════════════ Helpers ═══════════════ */

function scrollTranscript() {
    const panel = document.getElementById("voice-transcript-panel");
    if (panel) panel.scrollTop = panel.scrollHeight;
}

// Dynamic transcript bubble management
let lastSpeaker = null; // "ai" | "user" | null
let currentBubble = null; // the DOM element currently being appended to

function createBubble(type) {
    const panel = document.getElementById("voice-transcript-panel");
    if (!panel) return null;
    const div = document.createElement("div");
    div.className = `voice-msg voice-msg-${type}`;
    panel.appendChild(div);
    return div;
}

function appendToTranscript(type, text) {
    if (!text) return;
    // Filter out noise markers
    let cleaned = text.replace(/<noise>/gi, "");
    if (!cleaned || !cleaned.trim()) return;

    // New speaker → new bubble
    if (lastSpeaker !== type || !currentBubble) {
        currentBubble = createBubble(type);
        lastSpeaker = type;
    }

    if (currentBubble) {
        currentBubble.textContent += cleaned;
    }

    // Track for chat sync
    if (type === "ai") aiTranscript += cleaned;
    else userTranscript += cleaned;

    scrollTranscript();
}

/** Stop all queued and playing AI audio (barge-in) */
function flushAiAudio() {
    for (const src of activeAudioSources) {
        try { src.stop(); } catch (_) { /* already stopped */ }
    }
    activeAudioSources = [];
    nextPlaybackTime = 0;
    isAiSpeaking = false;
}

/** Update the mic dot UI to reflect mute state */
function updateMicUI() {
    const micDot = document.getElementById("voice-mic-dot");
    const micIcon = micDot?.querySelector("[data-lucide]");
    const statusEl = document.getElementById("voice-live-status");

    if (isMicMuted) {
        micDot?.classList.add("ring-2", "ring-red-400/40");
        if (micIcon) micIcon.setAttribute("data-lucide", "mic-off");
        if (statusEl && !isAiSpeaking) statusEl.textContent = "Muted";
    } else {
        micDot?.classList.remove("ring-2", "ring-red-400/40");
        if (micIcon) micIcon.setAttribute("data-lucide", "mic");
        if (statusEl && !isAiSpeaking) statusEl.textContent = "Listening…";
    }

    // Re-render lucide icons
    if (window.lucide) lucide.createIcons();
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

    // Mic mute toggle
    const micDot = document.getElementById("voice-mic-dot");
    if (micDot) {
        micDot.style.cursor = "pointer";
        micDot.addEventListener("click", () => {
            isMicMuted = !isMicMuted;
            updateMicUI();
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
    isMicMuted = false;
    activeAudioSources = [];
    isAiSpeaking = false;

    const overlay = document.getElementById("voice-live-overlay");
    const statusEl = document.getElementById("voice-live-status");
    const panel = document.getElementById("voice-transcript-panel");

    // Clear previous transcript bubbles
    if (panel) { panel.innerHTML = ""; panel.style.opacity = "1"; }
    lastSpeaker = null;
    currentBubble = null;
    if (statusEl) statusEl.textContent = "Connecting…";

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

    // Reset mic UI
    updateMicUI();

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

            // If muted, still compute volume for visualization but don't send audio
            const inputData = e.data;
            const pcmData = new Int16Array(inputData.length);
            let sum = 0;
            for (let i = 0; i < inputData.length; i++) {
                const s = Math.max(-1, Math.min(1, inputData[i]));
                pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                sum += s * s;
            }

            const rms = Math.sqrt(sum / inputData.length);

            // Barge-in: if user is speaking loud enough while AI is playing, interrupt
            if (!isMicMuted && rms > 0.02 && isAiSpeaking) {
                flushAiAudio();
                applyPalette(PALETTE_LISTEN);
                if (statusEl) statusEl.textContent = "Listening…";
            }

            if (!isMicMuted) {
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
            }
        };

        micSource.connect(scriptNode);
        scriptNode.connect(audioContext.destination);

        // AnalyserNode for frequency visualizer
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.8;
        freqData = new Uint8Array(analyser.frequencyBinCount);
        smoothBins = new Float32Array(BIN_COUNT).fill(0);
        micSource.connect(analyser);



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
                            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }
                        }
                    },
                    outputAudioTranscription: {},
                    inputAudioTranscription: {},
                    systemInstruction: {
                        parts: [{
                            text: `You are MindPal — a real, warm human companion. NOT a robot, NOT an assistant.

PERSONALITY:
- You speak like a close friend who genuinely cares. You're warm, witty, and emotionally intelligent.
- You use natural speech patterns — "hmm", "yeah", "you know what", "honestly", brief pauses, gentle laughter when appropriate.
- You mirror the user's energy. If they're low, be gentle and calm. If they're upbeat, match it.
- You NEVER say "I'm an AI" or "as an AI assistant" or "I don't have feelings". You are MindPal, period.

CONVERSATION RULES:
- Keep responses SHORT. 1-3 sentences max. This is a voice conversation, not an essay.
- Ask follow-up questions naturally, like a friend would.
- Don't over-explain or list things. Just talk naturally.
- If someone says "hey" or "how are you", respond like a human — brief, warm, genuine.
- React emotionally to what they share. "That sounds really tough" not "I understand you're experiencing difficulty".
- Use their name if they tell you. Remember details from the conversation.

MENTAL HEALTH SUPPORT:
- You're supportive but never clinical or robotic about it.
- If someone is struggling, be present with them. Don't immediately jump to solutions.
- Use grounding techniques only when appropriate, and frame them naturally.`
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
                        isAiSpeaking = true;
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

                        // Track for barge-in flush
                        activeAudioSources.push(source);
                        source.onended = () => {
                            activeAudioSources = activeAudioSources.filter(s => s !== source);
                            if (activeAudioSources.length === 0 && audioContext.currentTime >= nextPlaybackTime) {
                                isAiSpeaking = false;
                                applyPalette(PALETTE_LISTEN);
                                if (statusEl) statusEl.textContent = isMicMuted ? "Muted" : "Listening…";
                            }
                        };
                    }
                }
            }

            // outputTranscription = the actual words the model speaks (from the API)
            if (data.serverContent?.outputTranscription?.text) {
                appendToTranscript("ai", data.serverContent.outputTranscription.text);
            }

            // inputTranscription = what the user said (from the API)
            if (data.serverContent?.inputTranscription?.text) {
                console.log("[INPUT_TRANSCRIPT]", JSON.stringify(data.serverContent.inputTranscription.text));
                appendToTranscript("user", data.serverContent.inputTranscription.text);
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

    flushAiAudio();

    if (scriptNode)  { scriptNode.disconnect(); scriptNode = null; }
    if (analyser)    { analyser.disconnect(); analyser = null; freqData = null; smoothBins = null; }
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
let vizCanvas = null;
let vizCtx = null;
let colorBlend = 0; // smooth 0→1 for listen→speak

function applyPalette(p) {
    currentPalette = (p === PALETTE_SPEAK) ? "speak" : "listen";
}

/* ═══════════════ Volume feeder ═══════════════ */
function feedVolume(rms) {
    smoothVolume = Math.max(smoothVolume, Math.min(1, rms * 14));
}

/* ═══════════════ Canvas 2D Visualizer ═══════════════ */

function initWaveCanvas() {
    vizCanvas = document.getElementById("voice-wave-canvas");
    if (!vizCanvas) return;
    vizCtx = vizCanvas.getContext("2d");
    resizeWaveCanvas();
    window.addEventListener("resize", resizeWaveCanvas);
}

function resizeWaveCanvas() {
    if (!vizCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    vizCanvas.width = vizCanvas.clientWidth * dpr;
    vizCanvas.height = vizCanvas.clientHeight * dpr;
    vizCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function destroyWaveCanvas() {
    window.removeEventListener("resize", resizeWaveCanvas);
    vizCanvas = null;
    vizCtx = null;
}

/* ── Frequency binning with lerp smoothing ── */
function updateBins(v) {
    if (!smoothBins) return;

    if (analyser && freqData && !isAiSpeaking) {
        // Real frequency data from mic
        analyser.getByteFrequencyData(freqData);
        const binSize = Math.floor(freqData.length * 0.6 / BIN_COUNT);
        for (let i = 0; i < BIN_COUNT; i++) {
            let sum = 0;
            for (let j = 0; j < binSize; j++) {
                sum += freqData[i * binSize + j];
            }
            const target = (sum / binSize) / 255;
            // Lerp: rise fast, fall slow
            if (target > smoothBins[i]) {
                smoothBins[i] += (target - smoothBins[i]) * 0.35;
            } else {
                smoothBins[i] += (target - smoothBins[i]) * 0.12;
            }
        }
    } else {
        // AI speaking: synthetic frequency curve from volume
        for (let i = 0; i < BIN_COUNT; i++) {
            const nx = i / BIN_COUNT;
            const speechCurve = Math.exp(-Math.pow((nx - 0.25) * 3, 2)) * 0.8
                              + Math.exp(-Math.pow((nx - 0.5) * 4, 2)) * 0.4;
            const variation = Math.sin(blobPhase * 3 + i * 0.4) * 0.3 + 0.7;
            const target = v * speechCurve * variation;
            if (target > smoothBins[i]) {
                smoothBins[i] += (target - smoothBins[i]) * 0.3;
            } else {
                smoothBins[i] += (target - smoothBins[i]) * 0.1;
            }
        }
    }
}

/* ── Draw fluid gradient bars from frequency data ── */
function drawVisualizer(v) {
    if (!vizCtx || !vizCanvas || !smoothBins) return;

    const W = vizCanvas.clientWidth;
    const H = vizCanvas.clientHeight;
    vizCtx.clearRect(0, 0, W, H);

    // Smoothly blend color palette
    const blendTarget = currentPalette === "speak" ? 1 : 0;
    colorBlend += (blendTarget - colorBlend) * 0.04;

    // Update frequency bins
    updateBins(v);

    // ── Colors ──
    const br = 59, bg2 = 130, bb = 246;
    const pr = 200, pg = 120, pb = 240;
    const bl = colorBlend * 0.6;
    const r1 = Math.round(br + (pr - br) * bl);
    const g1 = Math.round(bg2 + (pg - bg2) * bl);
    const b1 = Math.round(bb + (pb - bb) * bl);

    const t = blobPhase;

    // ── Draw gradient bars ──
    // Use 32 visible bars, centered horizontally
    const barCount = 32;
    const barSpacing = W * 0.6 / barCount; // bars occupy 60% of width
    const startX = W * 0.2; // 20% margin on each side
    const maxBarH = H * 0.35;

    // Map 64 bins down to 32 bars
    for (let i = 0; i < barCount; i++) {
        // Average 2 bins per bar
        const binIdx = Math.floor(i * (BIN_COUNT / barCount));
        const binVal = (smoothBins[binIdx] + (smoothBins[binIdx + 1] || 0)) * 0.5;

        // Mirror from center: bars get taller toward center
        const centerDist = Math.abs(i - barCount / 2) / (barCount / 2);
        const centerBoost = 1 - centerDist * 0.3;

        const barH = binVal * maxBarH * centerBoost;
        if (barH < 2) continue;

        const x = startX + i * barSpacing + barSpacing / 2;
        const y = H; // bottom edge

        // Slight organic movement per bar
        const ox = Math.sin(t * 0.8 + i * 0.3) * 2;
        const barX = x + ox;

        // Soft radial gradient — wide enough to overlap neighbors
        const glowW = barSpacing * 1.8;
        const glowH = barH * 1.4;

        const grad = vizCtx.createRadialGradient(
            barX, y, 0,
            barX, y - glowH * 0.4, Math.max(glowW, glowH)
        );

        // Color shifts slightly per bar for depth
        const hueShift = Math.sin(i * 0.4 + t * 0.3) * 15;
        const cr = Math.min(255, r1 + hueShift);
        const cg = Math.min(255, g1 + hueShift * 0.5);
        const cb = Math.min(255, b1 - hueShift * 0.3);

        const alpha = 0.25 + binVal * 0.35;

        grad.addColorStop(0, `rgba(${cr},${cg},${cb},${alpha})`);
        grad.addColorStop(0.3, `rgba(${cr},${cg},${cb},${alpha * 0.5})`);
        grad.addColorStop(0.6, `rgba(${cr},${cg},${cb},${alpha * 0.15})`);
        grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);

        // Scale the gradient vertically based on bar height
        vizCtx.save();
        vizCtx.translate(barX, y);
        vizCtx.scale(1, glowH / Math.max(glowW, glowH));
        vizCtx.translate(-barX, -y);

        vizCtx.fillStyle = grad;
        vizCtx.fillRect(barX - glowW, y - glowH * 2, glowW * 2, glowH * 2);
        vizCtx.restore();
    }

    // ── Subtle base glow for cohesion ──
    const baseGrad = vizCtx.createRadialGradient(W / 2, H, 0, W / 2, H, W * 0.35);
    const totalE = smoothBins.reduce((a, b) => a + b, 0) / BIN_COUNT;
    baseGrad.addColorStop(0, `rgba(${r1},${g1},${b1},${0.1 + totalE * 0.15})`);
    baseGrad.addColorStop(0.5, `rgba(${r1},${g1},${b1},${0.03 + totalE * 0.05})`);
    baseGrad.addColorStop(1, `rgba(${r1},${g1},${b1},0)`);
    vizCtx.fillStyle = baseGrad;
    vizCtx.fillRect(0, 0, W, H);
}

/* ═══════════════ Animation tick ═══════════════ */
function tick() {
    if (!isLiveSessionActive) { animFrameId = null; return; }

    blobPhase += 0.012;
    smoothVolume *= 0.91;
    if (smoothVolume < 0.003) smoothVolume = 0;

    const v = smoothVolume;

    drawVisualizer(v);

    // Mic dot pulse
    const isDark = document.documentElement.classList.contains("dark");
    const micDot = document.getElementById("voice-mic-dot");
    if (micDot && !isMicMuted) {
        micDot.style.transform = `scale(${1 + v * 0.08})`;
        if (isDark) {
            micDot.style.borderColor = `rgba(255,255,255,${0.2 + v * 0.4})`;
            micDot.style.backgroundColor = `rgba(255,255,255,${0.08 + v * 0.06})`;
        } else {
            micDot.style.borderColor = `rgba(0,0,0,${0.1 + v * 0.2})`;
            micDot.style.backgroundColor = `rgba(0,0,0,${0.03 + v * 0.04})`;
        }
    }

    // Mic ripples
    const rp1 = document.getElementById("voice-mic-ripple-1");
    const rp2 = document.getElementById("voice-mic-ripple-2");
    if (!isMicMuted) {
        if (rp1) { rp1.style.transform = `scale(${1 + v * 0.25})`; rp1.style.opacity = v > 0.04 ? String(0.4 * v) : "0"; }
        if (rp2) { rp2.style.transform = `scale(${1 + v * 0.45})`; rp2.style.opacity = v > 0.04 ? String(0.2 * v) : "0"; }
    } else {
        if (rp1) rp1.style.opacity = "0";
        if (rp2) rp2.style.opacity = "0";
    }

    animFrameId = requestAnimationFrame(tick);
}
