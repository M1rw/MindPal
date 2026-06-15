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
    // Filter out noise markers without collapsing natural spaces
    const cleaned = text.replace(/<noise>/gi, "");
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
let gl = null;
let glProgram = null;
let glCanvas = null;
let colorBlend = 0; // smooth 0→1 for listen→speak

function applyPalette(p) {
    currentPalette = (p === PALETTE_SPEAK) ? "speak" : "listen";
}

/* ═══════════════ Volume feeder ═══════════════ */
function feedVolume(rms) {
    smoothVolume = Math.max(smoothVolume, Math.min(1, rms * 14));
}

/* ═══════════════ WebGL Wave ═══════════════ */
const VERT_SRC = `attribute vec2 a_pos;void main(){gl_Position=vec4(a_pos,0,1);}`;

const FRAG_SRC = `
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_vol;
uniform float u_blend;
uniform float u_dark;

// Smooth noise-like function from sine harmonics
float wave(float x, float t, float freq, float speed, float phase) {
    return sin(x * freq + t * speed + phase)
         + 0.5 * sin(x * freq * 1.73 + t * speed * 0.67 + phase + 1.3)
         + 0.3 * sin(x * freq * 0.51 + t * speed * 1.41 + phase + 2.7)
         + 0.15 * sin(x * freq * 2.31 + t * speed * 0.83 + phase + 4.1);
}

void main() {
    vec2 uv = gl_FragCoord.xy / u_res;
    float x = uv.x;
    float y = uv.y; // 0=bottom, 1=top

    // Volume drives wave height
    float vol = u_vol;
    float t = u_time;

    // 3 wave layers with different frequencies and phases
    float baseH1 = 0.12 + vol * 0.22;
    float baseH2 = 0.09 + vol * 0.17;
    float baseH3 = 0.06 + vol * 0.12;

    float amp = 0.03 + vol * 0.08;

    float w1 = baseH1 + wave(x * 3.14159, t, 1.8, 1.0, 0.0) * amp;
    float w2 = baseH2 + wave(x * 3.14159, t, 2.3, 0.7, 2.0) * amp * 0.8;
    float w3 = baseH3 + wave(x * 3.14159, t, 2.9, 1.3, 4.0) * amp * 0.6;

    // Blue colors
    vec3 blue1 = vec3(0.23, 0.51, 0.97);   // blue-500
    vec3 blue2 = vec3(0.38, 0.65, 0.98);   // blue-400
    vec3 blue3 = vec3(0.58, 0.77, 0.99);   // blue-300

    // Pink accent colors
    vec3 pink1 = vec3(0.91, 0.47, 0.98);   // fuchsia-400
    vec3 pink2 = vec3(0.82, 0.55, 0.95);   // purple-400
    vec3 pink3 = vec3(0.72, 0.65, 0.99);   // violet-300

    // Interpolate between blue and pink based on blend
    vec3 c1 = mix(blue1, pink1, u_blend * 0.7);
    vec3 c2 = mix(blue2, pink2, u_blend * 0.5);
    vec3 c3 = mix(blue3, pink3, u_blend * 0.3);

    float alpha = 0.0;
    vec3 color = vec3(0.0);

    // Layer 3 (back, widest, most transparent)
    if (y < w3) {
        float fade = smoothstep(w3, w3 * 0.3, y);
        float edge = 1.0 - smoothstep(w3 - amp * 0.5, w3, y);
        float a3 = fade * (0.15 + vol * 0.12) + edge * (0.08 + vol * 0.1);
        color = mix(color, c3, a3);
        alpha = max(alpha, a3);
    }

    // Layer 2 (middle)
    if (y < w2) {
        float fade = smoothstep(w2, w2 * 0.2, y);
        float edge = 1.0 - smoothstep(w2 - amp * 0.4, w2, y);
        float a2 = fade * (0.22 + vol * 0.18) + edge * (0.12 + vol * 0.15);
        color = mix(color, c2, a2);
        alpha = max(alpha, a2);
    }

    // Layer 1 (front, brightest)
    if (y < w1) {
        float fade = smoothstep(w1, w1 * 0.1, y);
        float edge = 1.0 - smoothstep(w1 - amp * 0.3, w1, y);
        float a1 = fade * (0.3 + vol * 0.25) + edge * (0.15 + vol * 0.2);
        color = mix(color, c1, a1);
        alpha = max(alpha, a1);
    }

    // Glow at wave edges — soft bright line
    float glow = 0.0;
    glow += (0.4 + vol * 0.5) * exp(-pow((y - w1) * (40.0 - vol * 15.0), 2.0));
    glow += (0.25 + vol * 0.3) * exp(-pow((y - w2) * (35.0 - vol * 10.0), 2.0));
    glow += (0.15 + vol * 0.2) * exp(-pow((y - w3) * (30.0 - vol * 8.0), 2.0));

    // Glow color — brighter version
    vec3 glowColor = mix(c1, vec3(1.0), 0.4);
    color += glowColor * glow;
    alpha = max(alpha, glow * 0.6);

    // Subtle ambient fill for bottom
    float ambientY = smoothstep(0.15 + vol * 0.1, 0.0, y);
    color = mix(color, c1 * 0.5, ambientY * (0.08 + vol * 0.05));
    alpha = max(alpha, ambientY * (0.06 + vol * 0.04));

    gl_FragColor = vec4(color, alpha);
}
`;

function initWaveCanvas() {
    glCanvas = document.getElementById("voice-wave-canvas");
    if (!glCanvas) return;

    gl = glCanvas.getContext("webgl", { alpha: true, premultipliedAlpha: false, antialias: true });
    if (!gl) {
        // Fallback: no WebGL — just leave canvas blank
        console.warn("WebGL not available for voice wave");
        return;
    }

    // Compile shaders
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, VERT_SRC);
    gl.compileShader(vs);

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, FRAG_SRC);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        console.error("Fragment shader error:", gl.getShaderInfoLog(fs));
        return;
    }

    glProgram = gl.createProgram();
    gl.attachShader(glProgram, vs);
    gl.attachShader(glProgram, fs);
    gl.linkProgram(glProgram);
    gl.useProgram(glProgram);

    // Fullscreen quad
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(glProgram, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // Enable blending for alpha
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    resizeWaveCanvas();
    window.addEventListener("resize", resizeWaveCanvas);
}

function resizeWaveCanvas() {
    if (!glCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    glCanvas.width = glCanvas.clientWidth * dpr;
    glCanvas.height = glCanvas.clientHeight * dpr;
    if (gl) gl.viewport(0, 0, glCanvas.width, glCanvas.height);
}

function destroyWaveCanvas() {
    window.removeEventListener("resize", resizeWaveCanvas);
    if (gl && glProgram) {
        gl.deleteProgram(glProgram);
    }
    gl = null;
    glProgram = null;
    glCanvas = null;
}

function drawWave(v) {
    if (!gl || !glProgram || !glCanvas) return;

    // Smoothly blend toward target palette
    const target = currentPalette === "speak" ? 1 : 0;
    colorBlend += (target - colorBlend) * 0.04;

    const isDark = document.documentElement.classList.contains("dark");

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.uniform2f(gl.getUniformLocation(glProgram, "u_res"), glCanvas.width, glCanvas.height);
    gl.uniform1f(gl.getUniformLocation(glProgram, "u_time"), blobPhase);
    gl.uniform1f(gl.getUniformLocation(glProgram, "u_vol"), v);
    gl.uniform1f(gl.getUniformLocation(glProgram, "u_blend"), colorBlend);
    gl.uniform1f(gl.getUniformLocation(glProgram, "u_dark"), isDark ? 1.0 : 0.0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

/* ═══════════════ Animation tick ═══════════════ */
function tick() {
    if (!isLiveSessionActive) { animFrameId = null; return; }

    blobPhase += 0.012;
    smoothVolume *= 0.91;
    if (smoothVolume < 0.003) smoothVolume = 0;

    const v = smoothVolume;

    // Draw the WebGL fluid wave
    drawWave(v);

    // Mic dot pulse — theme-aware
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
    const r1 = document.getElementById("voice-mic-ripple-1");
    const r2 = document.getElementById("voice-mic-ripple-2");
    if (!isMicMuted) {
        if (r1) { r1.style.transform = `scale(${1 + v * 0.25})`; r1.style.opacity = v > 0.04 ? String(0.4 * v) : "0"; }
        if (r2) { r2.style.transform = `scale(${1 + v * 0.45})`; r2.style.opacity = v > 0.04 ? String(0.2 * v) : "0"; }
    } else {
        if (r1) r1.style.opacity = "0";
        if (r2) r2.style.opacity = "0";
    }

    animFrameId = requestAnimationFrame(tick);
}
