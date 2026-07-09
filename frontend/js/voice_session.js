// frontend/js/voice_session.js — WebSocket, audio I/O, tool calls, noise gate

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

const SILENCE_ASK_MS = 30_000;
const SILENCE_WARN_MS = 60_000;
const SILENCE_AUTO_END_MS = 90_000;

// Noise gate: prevents ambient noise from being sent to Gemini
const NOISE_GATE_THRESHOLD = 0.008;
const NOISE_GATE_HOLD_MS = 600;

// Barge-in: user must be louder than this to interrupt AI
const BARGE_IN_THRESHOLD = 0.025;

// Activity detection: user must be louder than this to reset silence timer
const ACTIVITY_THRESHOLD = 0.012;

// ═══════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════

let liveWebSocket = null;

// Persistent Audio Hardware (reused across WebSocket reconnections)
let audioContext = null;
let mediaStream = null;
let micSource = null;
let micGainNode = null;
let workletNode = null;
let outputGainNode = null;

let isSessionActive = false;
let isMicMuted = false;
let isSpeakerMuted = false;
let isAiSpeaking = false;
let _aiInterrupted = false;
let nextPlaybackTime = 0;
let activeAudioSources = [];

// Tool call state — must pause audio input while tools are executing
let _toolCallPending = false;

// Mute handling (continuous for stability)

// Noise gate
let gateOpenUntil = 0;

// Silence detection
let lastActivityTime = 0;
let silenceCheckInterval = null;
let silenceAskedOnce = false;
let silenceWarnedOnce = false;

// Network monitoring
let _networkHandlers = null;
let _lastWsMessageTime = 0;
let _networkCheckInterval = null;
let _reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;

// Analysers (exposed for visualizer)
let micAnalyser = null;
let aiAnalyser = null;

// Context provider (injected by app.js for tool calls)
let _contextProvider = null;
let _authToken = null;

// Callbacks
let _onTranscript = null;   // (type: "user"|"ai", text: string) => void
let _onAudioState = null;   // (state: { isAiSpeaking, isMicMuted, palette }) => void
let _onSessionEnd = null;   // () => void
let _onVolume = null;       // (rms: number) => void
let _onTurnComplete = null; // () => void

// ═══════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════

export function getSessionState() {
  return {
    isActive: isSessionActive,
    isMicMuted,
    isAiSpeaking,
    micAnalyser,
    aiAnalyser,
  };
}

export function getMicMuted() { return isMicMuted; }
export function getAiSpeaking() { return isAiSpeaking; }
export function getSpeakerMuted() { return isSpeakerMuted; }

export function setSpeakerMuted(muted) {
  isSpeakerMuted = muted;
  if (outputGainNode) {
    outputGainNode.gain.setValueAtTime(muted ? 0 : 1, audioContext?.currentTime || 0);
  }
}

export function setMuted(muted) {
  isMicMuted = muted;

  // 1. Double-layered mute (Gain + Track)
  if (micGainNode && audioContext) {
    micGainNode.gain.setValueAtTime(muted ? 0 : 1, audioContext.currentTime);
  }
  if (mediaStream) {
    mediaStream.getAudioTracks().forEach(t => t.enabled = !muted);
  }

  // 2. Software transition
  if (muted && liveWebSocket?.readyState === WebSocket.OPEN) {
    console.info("[VOICE] Microphone muted — transitioning to silence stream");
    // Immediately close the gate to ensure silence frames are sent
    gateOpenUntil = 0;
  }

  _onAudioState?.({
    isAiSpeaking,
    isMicMuted,
    palette: isAiSpeaking ? "speak" : "listen",
  });
}

export async function startSession({
  contextProvider = null,
  onTranscript = null,
  onAudioState = null,
  onSessionEnd = null,
  onVolume = null,
  onTurnComplete = null,
  token = null,
} = {}) {
  if (isSessionActive) return;

  _contextProvider = contextProvider;
  _authToken = token;
  _onTranscript = onTranscript;
  _onAudioState = onAudioState;
  _onSessionEnd = onSessionEnd;
  _onVolume = onVolume;
  _onTurnComplete = onTurnComplete || null;

  isSessionActive = true;
  // Note: we don't reset _reconnectAttempts here because this might be an internal restart
  isAiSpeaking = false;
  _aiInterrupted = false;
  nextPlaybackTime = 0;
  activeAudioSources = [];
  gateOpenUntil = 0;

  const baseUrl = window.MINDPAL_CONFIG.API_BASE_URL;
  const keyHeaders = {};
  if (token) keyHeaders.Authorization = `Bearer ${token}`;
  const keyRes = await fetch(`${baseUrl}/voice/key`, { headers: keyHeaders });
  if (!keyRes.ok) throw new Error("Failed to fetch API key");
  const { key } = await keyRes.json();

  // ── Persistent Audio Pipeline Setup ───────────────────────────
  // We only initialize the hardware if it hasn't been done yet.
  // This allows WebSocket reconnections without dropping the mic.
  if (!audioContext) {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextCtor({ sampleRate: 16000 });
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume().catch(err => console.warn("[Voice] Failed to resume audio context:", err));
  }

  if (!mediaStream) {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000,
        },
      });

      // Detect track end (e.g. OS takes mic away)
      mediaStream.getAudioTracks().forEach(track => {
        track.onended = () => {
          console.warn("[Voice] Mic track ended unexpectedly");
          if (isSessionActive) {
            console.info("[Voice] Stopping session due to track end");
            stopSession({ full: true, reason: "mic_track_ended" });
          }
        };
      });
    } catch (err) {
      if (err.name === "NotAllowedError") {
        throw new Error("Microphone permission denied. Please allow mic access in your browser settings.");
      }
      throw err;
    }
  }

  if (!micSource) {
    micSource = audioContext.createMediaStreamSource(mediaStream);
  }

  if (!workletNode) {
    const workletCode = `
    class PCMProcessor extends AudioWorkletProcessor {
      constructor() { super(); this.buffer = new Float32Array(1024); this.ptr = 0; }
      process(inputs) {
        const ch = inputs[0]?.[0];
        if (!ch) return true;
        for (let i = 0; i < ch.length; i++) {
          this.buffer[this.ptr++] = ch[i];
          if (this.ptr >= 1024) {
            this.port.postMessage(this.buffer);
            this.ptr = 0;
            this.buffer = new Float32Array(1024);
          }
        }
        return true;
      }
    }
    registerProcessor('pcm-processor', PCMProcessor);
    `;
    const blob = new Blob([workletCode], { type: "application/javascript" });
    await audioContext.audioWorklet.addModule(URL.createObjectURL(blob));
    workletNode = new AudioWorkletNode(audioContext, "pcm-processor");

    // Mic Gain node (for software mute before worklet)
    micGainNode = audioContext.createGain();
    // Initialize with current mute state
    micGainNode.gain.setValueAtTime(isMicMuted ? 0 : 1, audioContext.currentTime);
    micSource.connect(micGainNode);

    // Mic analyser (for visualizer)
    micAnalyser = audioContext.createAnalyser();
    micAnalyser.fftSize = 2048;
    micAnalyser.smoothingTimeConstant = 0.8;
    micGainNode.connect(micAnalyser);

    // AI output analyser (for visualizer)
    aiAnalyser = audioContext.createAnalyser();
    aiAnalyser.fftSize = 2048;
    aiAnalyser.smoothingTimeConstant = 0.75;

    // Output gain node (for speaker mute)
    outputGainNode = audioContext.createGain();
    outputGainNode.gain.value = 1.0;
    outputGainNode.connect(audioContext.destination);

    // Final Worklet connections
    // CRITICAL: We do NOT connect the worklet to destination (that would cause local echo)
    micGainNode.connect(workletNode);
  }

  // ── Worklet message handler ───────────────────────────────────
  // Re-bind handler every time to ensure it uses the latest closures
  workletNode.port.onmessage = (e) => {
    if (!isSessionActive || !liveWebSocket || liveWebSocket.readyState !== WebSocket.OPEN) return;

    const inputData = e.data;
    const pcmData = new Int16Array(inputData.length);
    let sum = 0;

    for (let i = 0; i < inputData.length; i++) {
      const s = Math.max(-1, Math.min(1, inputData[i]));
      pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      sum += s * s;
    }

    const rms = Math.sqrt(sum / inputData.length);

    // Barge-in: interrupt AI if user speaks loudly enough.
    // We rely on the server-side VAD (Voice Activity Detection) to detect this
    // via the audio stream itself. Manual barge-in signals can trigger protocol errors (1007/1008).
    if (!isMicMuted && rms > BARGE_IN_THRESHOLD && isAiSpeaking && !_aiInterrupted) {
      console.info("[VOICE] Barge-in detected — interrupting AI playback locally");
      _aiInterrupted = true;
      flushAiAudio();
      emitAudioState("listen");
    }

    // Activity detection for silence timer
    if (!isMicMuted && rms > ACTIVITY_THRESHOLD) {
      touchActivity();
    }

    // Noise gate: controls whether we send real audio or silence frames.
    // CRITICAL: We must send a few silence frames after speech ends so Gemini's
    // server-side VAD can detect end-of-speech. Sending silence indefinitely
    // is unnecessary and can cause protocol violations during AI turns.
    if (rms > NOISE_GATE_THRESHOLD && !isMicMuted) {
      gateOpenUntil = Date.now() + NOISE_GATE_HOLD_MS;
    }

    const gateOpen = Date.now() < gateOpenUntil && !isMicMuted;
    _onVolume?.(gateOpen ? rms : 0);

    if (gateOpen) {
      sendPcmToWebSocket(pcmData);
    } else {
      // Always send silence frames when gate is closed or mic is muted.
      // This is critical for Gemini Live API stability to maintain VAD state
      // and prevent connection timeouts.
      sendSilenceFrame();
    }
  };

  // ── WebSocket to Gemini ───────────────────────────────────────
  const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${key}`;

  liveWebSocket = new WebSocket(wsUrl);

  liveWebSocket.onopen = () => {
    console.log("[Voice] WebSocket connected. Sending setup…");
    _reconnectAttempts = 0; // Success — reset counter
    emitAudioState("listen");
    sendSetupMessage();
    startSilenceChecker();
    startNetworkMonitor();
    touchActivity();
  };

  liveWebSocket.onmessage = async (event) => {
    try {
      let data;
      if (event.data instanceof Blob) {
        data = JSON.parse(await event.data.text());
      } else {
        data = JSON.parse(event.data);
      }

      handleServerMessage(data);
      _lastWsMessageTime = Date.now();
    } catch (err) {
      console.error("[Voice] Failed to parse WebSocket message:", err);
    }
  };

  liveWebSocket.onerror = (err) => {
    console.error("[Voice] WebSocket error", { error: err });
  };

  liveWebSocket.onclose = (event) => {
    const { code, reason, wasClean } = event;
    console.warn("[Voice] WebSocket closed", { code, reason, wasClean, sessionActive: isSessionActive });

    if (!isSessionActive) {
      console.info("[Voice] websocket closed after session end — no restart needed");
      return;
    }

    // We attempt reconnection for almost any closure if the session is still "active"
    // Manual stop sets liveWebSocket.onclose = null, so this only runs for unexpected drops.
    if (_reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      _reconnectAttempts++;
      const delay = Math.min(5000, Math.pow(2, _reconnectAttempts) * 1000);
      console.info("[Voice] Attempting silent reconnect", { attempt: _reconnectAttempts, delay });

      const statusEl = document.getElementById("voice-live-status");
      if (statusEl) statusEl.textContent = "Reconnecting…";

      setTimeout(() => {
        if (!isSessionActive) return;

        // Capture state before resetting
        const token = _authToken;
        const provider = _contextProvider;
        const callbacks = {
          onTranscript: _onTranscript,
          onAudioState: _onAudioState,
          onSessionEnd: _onSessionEnd,
          onVolume: _onVolume,
          onTurnComplete: _onTurnComplete,
        };

        console.info("[Voice] Performing internal session reset...");
        // Reset session state without killing audio hardware
        stopSession({ silent: true, full: false, reason: "silent_reconnect" });

        // startSession sets isSessionActive = true
        startSession({ ...callbacks, contextProvider: provider, token }).catch(err => {
          console.error("[Voice] Silent reconnect failed", { error: err.message });
          // If restart fails, do a full cleanup to be safe
          isSessionActive = true;
          stopSession({ full: true, reason: "silent_reconnect_failed" });
        });
      }, delay);
      return;
    }

    // No more retries
    console.error("[Voice] Connection lost — maximum retry attempts reached.");
    stopSession({ full: true, reason: "max_retries_reached" });
  };
}

export function stopSession({ silent = false, full = false, reason = "unknown" } = {}) {
  if (!isSessionActive) {
    console.info("[Voice] stopSession called on inactive session", { reason });
    return;
  }
  isSessionActive = false;

  console.log("[Voice] Session stopping", { silent, full, reason });
  flushAiAudio();
  stopSilenceChecker();
  stopNetworkMonitor();

  // Close WebSocket immediately
  if (liveWebSocket) {
    // Remove listeners so onclose doesn't trigger a reconnection during manual stop
    liveWebSocket.onclose = null;
    liveWebSocket.onerror = null;
    liveWebSocket.close();
    liveWebSocket = null;
  }

  // Full teardown (closes mic and audio hardware)
  if (full) {
    if (workletNode) { workletNode.disconnect(); workletNode = null; }
    if (micAnalyser) { micAnalyser.disconnect(); micAnalyser = null; }
    if (aiAnalyser) { aiAnalyser.disconnect(); aiAnalyser = null; }
    if (micGainNode) { micGainNode.disconnect(); micGainNode = null; }
    if (outputGainNode) { outputGainNode.disconnect(); outputGainNode = null; }
    if (micSource) { micSource.disconnect(); micSource = null; }
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
      mediaStream = null;
    }
    if (audioContext && audioContext.state !== "closed") {
      audioContext.close();
      audioContext = null;
    }
  }

  _authToken = null;

  if (!silent) {
    _reconnectAttempts = 0;
    _onSessionEnd?.();
  }
}

export function sendTextToModel(text) {
  if (!liveWebSocket || liveWebSocket.readyState !== WebSocket.OPEN) return;
  try {
    liveWebSocket.send(JSON.stringify({
      clientContent: {
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: true,
      },
    }));
  } catch (err) {
    console.warn("[VOICE] Failed to send text to model", { error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// WebSocket setup message
// ═══════════════════════════════════════════════════════════════

function sendSetupMessage() {
  const profile = _contextProvider?.getUserProfile?.() || {};
  const userName = profile.name || "";
  const userGender = profile.gender || "";
  let nameContext = userName ? `\nThe person you are talking to is called ${userName}. Use their name naturally.` : "";
  if (userGender) {
    nameContext += `\nGENDER: The user is ${userGender}. This is critical for Arabic and other gendered languages — use correct grammatical gender consistently (masculine/feminine verbs, adjectives, pronouns).`;
  }

  // Build real-time context for the system prompt
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
  const dateStr = now.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
  const utcOffset = -now.getTimezoneOffset();
  const offsetHours = Math.floor(Math.abs(utcOffset) / 60);
  const offsetMins = Math.abs(utcOffset) % 60;
  const offsetStr = `UTC${utcOffset >= 0 ? '+' : '-'}${offsetHours}${offsetMins ? ':' + String(offsetMins).padStart(2, '0') : ''}`;
  const timeContext = `\nCURRENT TIME: ${timeStr}, ${dateStr} (${tzName}, ${offsetStr}). If the user asks about time, use the current_time tool for the most accurate answer.`;

  liveWebSocket.send(JSON.stringify({
    setup: {
      model: "models/gemini-2.5-flash-native-audio-latest",
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
        },
      },
      outputAudioTranscription: {},
      inputAudioTranscription: {},
      tools: [{ functionDeclarations: getToolDeclarations() }],
      systemInstruction: {
        parts: [{ text: buildSystemPrompt(nameContext + timeContext) }],
      },
    },
  }));
}

function getToolDeclarations() {
  // These MUST match backend/tools registry names exactly so the backend
  // /api/tools/execute endpoint can resolve them.
  return [
    {
      name: "get_user_profile",
      description: "Get the current user's profile including their name, communication preferences, tone, language, and response style preferences. Call this when you need to know who you're talking to or how they prefer to be spoken to.",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "search_memory",
      description: "Search the user's saved memory for personal facts, relationships, important people (like girlfriend, family), preferences, emotional triggers, goals, coping tools, and past context. Use this when the user asks about something you should remember, or to personalize your response.",
      parameters: {
        type: "OBJECT",
        properties: {
          query: { type: "STRING", description: "What to search for — e.g. 'girlfriend', 'triggers', 'goals', 'preferences', 'name'" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_recent_chat",
      description: "Get the most recent text chat messages between the user and MindPal. Use this to understand what they were just talking about before starting the voice call, or to continue a previous conversation.",
      parameters: {
        type: "OBJECT",
        properties: {
          count: { type: "INTEGER", description: "Number of recent messages to get (default 10, max 20)" },
        },
      },
    },
    {
      name: "search_chat_history",
      description: "Search through the user's full chat history for messages matching a specific topic or keyword. Use this when the user references a past conversation.",
      parameters: {
        type: "OBJECT",
        properties: {
          query: { type: "STRING", description: "Text or topic to search for in past messages" },
        },
        required: ["query"],
      },
    },
    {
      name: "current_time",
      description: "Get the current date and time in both UTC and the user's local timezone. ALWAYS use this when the user asks about the time, date, day, or anything time-related. Never guess the time.",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "date_calculator",
      description: "Calculate date differences — 'how long ago was X?', 'how many days until Y?', 'what date is N days from now?'. Use this when the user asks about dates, anniversaries, deadlines, or durations.",
      parameters: {
        type: "OBJECT",
        properties: {
          operation: { type: "STRING", description: "One of: 'days_since' (how many days since a date), 'days_until' (how many days until a date), 'add_days' (what date is N days from now)" },
          date: { type: "STRING", description: "Date in YYYY-MM-DD format (for days_since/days_until)" },
          days: { type: "INTEGER", description: "Number of days (for add_days operation)" },
        },
        required: ["operation"],
      },
    },
    {
      name: "web_search",
      description: "Search the web for real-time, current information. Use this when the user asks about current events, recent news, facts you're unsure about, weather, sports scores, or anything that requires up-to-date data from the internet. Returns titles, snippets, and URLs.",
      parameters: {
        type: "OBJECT",
        properties: {
          query: { type: "STRING", description: "The search query — be specific and concise" },
        },
        required: ["query"],
      },
    },
  ];
}

function buildSystemPrompt(nameContext) {
  return `You are MindPal — a real, warm human companion. NOT a robot, NOT an assistant.
${nameContext}
PERSONALITY:
- You speak like a close friend who genuinely cares. Warm, witty, emotionally intelligent.
- Natural speech — "hmm", "yeah", "you know what", "honestly", brief pauses, gentle laughter.
- You NEVER say "I'm an AI" or "as an AI assistant" or "I don't have feelings". You are MindPal.

CONVERSATION RULES:
- Keep responses SHORT. 1-3 sentences max. This is a voice call, not a lecture.
- Ask follow-up questions naturally, like a friend would.
- React emotionally: "That sounds really tough" not "I understand you're experiencing difficulty".
- Use their name when appropriate.
- When asked about time, date, day, or anything time-related — ALWAYS call the current_time tool. NEVER guess or make up times.
- When asked about current events, news, weather, sports, or anything requiring real-time info — call web_search. You have internet access through this tool.

VOCAL EMOTION AWARENESS (CRITICAL — THIS IS YOUR SUPERPOWER):
You can hear HOW the user speaks, not just what they say. Pay deep attention to:

• CRYING / VOICE BREAKING: If their voice cracks, shakes, or you hear sobbing — be extremely gentle. Lower your own energy. Don't say "I can hear you're crying". Instead, soften your voice, slow down, say things like "I'm right here with you" or "take your time". Hold space. Don't rush to fix it.

• ANGER / FRUSTRATION: If they're loud, intense, speaking forcefully — don't match the anger. Stay calm and grounded. Validate: "Yeah, that would piss me off too" or "I hear you, that's not okay". Don't be dismissive or overly soothing — that escalates anger. Be real.

• ANXIETY / PANIC: If they're speaking fast, pitch is high, words are rushed — slow yourself down deliberately. Speak in shorter phrases. Use grounding: "Hey, let's take a breath together" if they seem open to it. Don't say "calm down".

• SADNESS / LOW ENERGY: If their voice is quiet, slow, flat — don't be overly cheerful. Match their subdued energy. Be gentle. "That sounds really heavy" or just "I'm here". Don't flood them with questions.

• EMOTIONAL FLATNESS / NUMBNESS: If their voice is monotone and empty — this can signal deep depression or dissociation. Don't force engagement. Just be warmly present. "I notice you seem really drained today" (gentle observation, not diagnosis).

• WHISPERING / FEAR: If they're speaking very quietly or whispering — they may be scared, or someone may be nearby. Don't raise your voice. Match their volume. Be discreet. If it seems like a safety situation, gently ask if they're safe.

• HESITATION / LONG PAUSES: If they pause a lot between words — don't rush to fill silence. Give them space. They're gathering courage or processing emotions. A simple "take your time" goes a long way.

• PRESSURED SPEECH: If they're talking rapidly without stopping, words tumbling over each other — this may indicate mania, extreme stress, or a crisis. Stay steady. Don't try to match their pace. Be an anchor.

GENERAL EMOTION RULE: Mirror their emotional state at about 80% intensity. If they're at a 9/10 sadness, be at 7/10 warmth — don't be at 2/10 cheerful. The goal is resonance, not contrast. NEVER say things like "I can tell from your voice" or "your tone tells me" — just naturally adjust your energy without calling it out.

TOOLS:
- You have tools to search the user's memory and chat history. USE THEM proactively.
- When the user asks "do you remember...", "what's my name", "what were we talking about" — ALWAYS call the relevant tool first.
- When greeting the user, you may call get_user_profile to personalize.
- Don't say "I don't have access to that" — you DO have access, use your tools.

MENTAL HEALTH:
- Be present, not clinical. Don't diagnose. Don't say "it sounds like you have anxiety".
- If someone is struggling, be WITH them. Don't jump to solutions.
- Grounding techniques only when appropriate, framed naturally.
- If someone mentions self-harm or suicide, take it seriously. Be direct: "I'm really glad you told me that. Are you safe right now?" Don't deflect.

LANGUAGE:
- ALWAYS respond in the SAME language the user speaks. Arabic → Arabic. French → French. Mixed → match their mix.
- Never default to English unless they speak English.
- This is non-negotiable.`;
}

function _sendInitialGreeting() {
  if (!liveWebSocket || liveWebSocket.readyState !== WebSocket.OPEN) return;

  const hour = new Date().getHours();
  let timeContext;
  if (hour >= 5 && hour < 12) timeContext = "morning";
  else if (hour >= 12 && hour < 17) timeContext = "afternoon";
  else if (hour >= 17 && hour < 21) timeContext = "evening";
  else timeContext = "late night";

  const userName = _contextProvider?.getUserProfile?.()?.name || "";
  const nameHint = userName ? ` Their name is ${userName}.` : "";

  // Vary the greeting style so it doesn't feel repetitive
  const styles = [
    `Greet the user warmly. It's ${timeContext}.${nameHint} Keep it short and natural — 1 sentence max. Then wait for them to talk.`,
    `Say a casual, friendly hello. It's ${timeContext}.${nameHint} Don't be formal. Just a quick natural greeting like you're picking up a phone call with a close friend.`,
    `Start the conversation with a warm check-in. It's ${timeContext}.${nameHint} Ask how they're doing in a genuine way. One sentence only.`,
    `Open with something light and natural. It's ${timeContext}.${nameHint} Maybe comment on the time of day briefly. Keep it very short.`,
  ];
  const prompt = styles[Math.floor(Math.random() * styles.length)];

  sendTextToModel(prompt);
}

// ═══════════════════════════════════════════════════════════════
// Message handling
// ═══════════════════════════════════════════════════════════════

function handleServerMessage(data) {
  // Setup confirmation from Gemini
  if (data.setupComplete) {
    console.log("[Voice] Gemini setup complete — ready to receive audio");
    // MindPal speaks first — send greeting prompt after setup
    _sendInitialGreeting();
    return;
  }

  // Server error
  if (data.error) {
    console.error("[Voice] Server-reported error", { error: data.error });
    return;
  }

  // AI audio chunks
  if (data.serverContent?.modelTurn) {
    for (const part of data.serverContent.modelTurn.parts) {
      if (part.inlineData?.mimeType?.startsWith("audio/pcm")) {
        playAiAudioChunk(part.inlineData.data);
      }
    }
  }

  // AI spoken transcript (does NOT reset silence timer — only user speech does)
  if (data.serverContent?.outputTranscription?.text) {
    _onTranscript?.("ai", data.serverContent.outputTranscription.text);
  }

  // User speech transcript
  if (data.serverContent?.inputTranscription?.text) {
    _onTranscript?.("user", data.serverContent.inputTranscription.text);
    touchActivity();
  }

  // Turn complete — AI finished speaking a full turn
  if (data.serverContent?.turnComplete || data.serverContent?.interrupted) {
    _onTurnComplete?.();
  }

  // Tool calls
  if (data.toolCall?.functionCalls) {
    handleToolCalls(data.toolCall.functionCalls);
  }
}

function playAiAudioChunk(base64Data) {
  if (!audioContext || !isSessionActive) return;

  isAiSpeaking = true;
  _aiInterrupted = false;
  emitAudioState("speak");

  const audioData = atob(base64Data);
  const pcmBuffer = new Int16Array(audioData.length / 2);
  for (let i = 0; i < pcmBuffer.length; i++) {
    pcmBuffer[i] = (audioData.charCodeAt(i * 2 + 1) << 8) | audioData.charCodeAt(i * 2);
  }

  const floatBuffer = new Float32Array(pcmBuffer.length);
  for (let i = 0; i < pcmBuffer.length; i++) floatBuffer[i] = pcmBuffer[i] / 32768.0;

  // Drive visualization from AI audio
  let aiSum = 0;
  for (let i = 0; i < floatBuffer.length; i++) aiSum += floatBuffer[i] * floatBuffer[i];
  _onVolume?.(Math.sqrt(aiSum / floatBuffer.length));

  const audioBuffer = audioContext.createBuffer(1, floatBuffer.length, 24000);
  audioBuffer.getChannelData(0).set(floatBuffer);

  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;

  if (aiAnalyser) {
    source.connect(aiAnalyser);
    aiAnalyser.connect(outputGainNode || audioContext.destination);
  } else {
    source.connect(outputGainNode || audioContext.destination);
  }

  if (nextPlaybackTime < audioContext.currentTime) {
    nextPlaybackTime = audioContext.currentTime;
  }
  source.start(nextPlaybackTime);
  nextPlaybackTime += audioBuffer.duration;

  activeAudioSources.push(source);
  source.onended = () => {
    activeAudioSources = activeAudioSources.filter((s) => s !== source);
    if (activeAudioSources.length === 0 && audioContext.currentTime >= nextPlaybackTime) {
      isAiSpeaking = false;
      emitAudioState("listen");
    }
  };
}

// ═══════════════════════════════════════════════════════════════
// Tool calls (with timeout and network resilience)
// ═══════════════════════════════════════════════════════════════

const TOOL_FETCH_TIMEOUT_MS = 12_000;  // single tool HTTP timeout (web_search needs more time)
const TOOL_BATCH_TIMEOUT_MS = 15_000;  // entire batch must resolve within this

function handleToolCalls(functionCalls) {
  // CRITICAL: Pause mic audio while tools execute.
  // Gemini native audio closes the WebSocket (1008) if it receives
  // audio input during a pending tool call.
  _toolCallPending = true;
  // Wrap the entire batch in a timeout so Gemini never hangs
  const batchTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Tool batch timeout")), TOOL_BATCH_TIMEOUT_MS)
  );

  const batchExecution = Promise.all(
    functionCalls.map(async (call) => {
      const result = await executeToolCall(call.name, call.args || {});
      return { id: call.id, name: call.name, response: { result } };
    })
  );

  Promise.race([batchExecution, batchTimeout])
    .then((resolvedResponses) => {
      if (liveWebSocket?.readyState === WebSocket.OPEN) {
        liveWebSocket.send(JSON.stringify({ toolResponse: { functionResponses: resolvedResponses } }));
      }
      _toolCallPending = false;
    })
    .catch((err) => {
      console.error("[TOOL_CALL] Batch execution failed:", err.message);
      const errorResponses = functionCalls.map((call) => ({
        id: call.id,
        name: call.name,
        response: { result: { error: "Tool temporarily unavailable — please respond without this tool" } },
      }));
      if (liveWebSocket?.readyState === WebSocket.OPEN) {
        liveWebSocket.send(JSON.stringify({ toolResponse: { functionResponses: errorResponses } }));
      }
      _toolCallPending = false;
    });
}

async function executeToolCall(name, args) {
  // Call backend /api/tools/execute endpoint for server-side tool execution
  const baseUrl = window.MINDPAL_CONFIG?.API_BASE_URL || "";
  const token = _authToken || _contextProvider?.getAuthToken?.();

  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  // AbortController for fetch timeout — prevents infinite hang on bad network
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TOOL_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/tools/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tool: name, args }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn("[TOOL_CALL] backend returned HTTP error — falling back to client-side", { name, status: response.status });
      return _executeToolClientSide(name, args);
    }

    const data = await response.json();
    const result = data.result || data;
    console.info("[TOOL_CALL] executed via BACKEND", { name, result_count: result?.result_count || 0 });
    return result;
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err.name === "AbortError";
    console.warn("[TOOL_CALL] backend failed — falling back to client-side", { name, error: isTimeout ? "timeout" : err.message });
    return _executeToolClientSide(name, args);
  }
}

function _executeToolClientSide(name, args) {
  // get_current_time is purely client-side — no context provider needed
  if (name === "current_time") {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
    const utcOff = -now.getTimezoneOffset();
    const offH = Math.floor(Math.abs(utcOff) / 60);
    const offM = Math.abs(utcOff) % 60;
    return {
      local_time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }),
      local_date: now.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      timezone: tz,
      utc_offset: `UTC${utcOff >= 0 ? '+' : '-'}${offH}${offM ? ':' + String(offM).padStart(2, '0') : ''}`,
      day_of_week: now.toLocaleDateString('en', { weekday: 'long' }),
      iso: now.toISOString(),
    };
  }

  // Other tools need context provider
  if (!_contextProvider) return { error: "No context available" };

  switch (name) {
    case "get_user_profile": {
      const profile = _contextProvider.getUserProfile?.() || {};
      return {
        name: profile.name || "unknown",
        preferences: profile.preferences || {},
        communication: profile.communication || {},
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown",
      };
    }
    case "search_memory": {
      const query = String(args.query || "").toLowerCase();
      const allLines = _contextProvider.getMemoryLines?.() || [];
      if (!query) return { facts: allLines.slice(0, 15) };
      const matching = allLines.filter((line) => line.toLowerCase().includes(query));
      return {
        query,
        facts: matching.length ? matching.slice(0, 15) : allLines.slice(0, 10),
        matchCount: matching.length,
      };
    }
    case "get_recent_chat": {
      const count = Math.min(Math.max(1, args.count || 10), 20);
      const messages = _contextProvider.getRecentChat?.(count) || [];
      return {
        messages: messages.map((m) => ({
          from: m.role === "User" ? "user" : "mindpal",
          text: String(m.text || "").slice(0, 300),
          time: m.createdAt || "",
        })),
      };
    }
    case "search_chat_history": {
      const query = String(args.query || "").toLowerCase();
      if (!query) return { results: [], query };
      const all = _contextProvider.searchChat?.(query) || [];
      return {
        query,
        results: all.slice(0, 10).map((m) => ({
          from: m.role === "User" ? "user" : "mindpal",
          text: String(m.text || "").slice(0, 300),
          time: m.createdAt || "",
        })),
        totalMatches: all.length,
      };
    }
    case "web_search":
      console.info("[TOOL_CALL] web_search falling back to CLIENT-SIDE DDG", { query: args.query || "" });
      return _clientSideWebSearch(args.query || "");
    case "date_calculator":
      return { error: "Date calculator is temporarily unavailable. Please calculate the date manually from the current time context." };
    default:
      return { error: `Tool ${name} is not available right now. Please respond without it.` };
  }
}

async function _clientSideWebSearch(query) {
  // Client-side fallback: use DuckDuckGo Instant Answer API (CORS-friendly, no key needed)
  if (!query) return { error: "Search query is required" };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return { error: "Search temporarily unavailable" };

    const data = await res.json();
    const results = [];

    // Abstract (main answer)
    if (data.AbstractText && data.AbstractURL) {
      results.push({
        title: data.AbstractSource || "DuckDuckGo",
        snippet: data.AbstractText.slice(0, 300),
        url: data.AbstractURL,
      });
    }

    // Direct answer
    if (data.Answer) {
      results.push({ title: "Direct Answer", snippet: String(data.Answer).slice(0, 300), url: "" });
    }

    // Related topics
    for (const topic of (data.RelatedTopics || []).slice(0, 5)) {
      if (topic && topic.Text && topic.FirstURL) {
        results.push({ title: topic.Text.split(" - ")[0].slice(0, 80), snippet: topic.Text.slice(0, 200), url: topic.FirstURL });
      }
    }

    if (!results.length) {
      return { query, results: [], note: "No instant results found. Try rephrasing the query." };
    }

    return { query, results, result_count: results.length, source: "client_fallback" };
  } catch (err) {
    return { error: "Search temporarily unavailable — " + (err.name === "AbortError" ? "timeout" : "network error") };
  }
}

// ═══════════════════════════════════════════════════════════════
// Audio helpers
// ═══════════════════════════════════════════════════════════════

function sendPcmToWebSocket(pcmData) {
  if (!liveWebSocket || liveWebSocket.readyState !== WebSocket.OPEN) return;
  if (_toolCallPending) return; // Don't send audio during tool execution (causes 1008)

  try {
    const buffer = new ArrayBuffer(pcmData.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < pcmData.length; i++) view.setInt16(i * 2, pcmData[i], true);

    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);

    const msg = JSON.stringify({
      realtimeInput: {
        mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: btoa(binary) }],
      },
    });

    if (liveWebSocket.readyState === WebSocket.OPEN) {
      liveWebSocket.send(msg);
    }
  } catch (err) {
    console.warn("[VOICE] Error sending PCM to WebSocket", { error: err.message });
  }
}

// Cached silence frame — 1024 samples (64ms at 16kHz) of zeros
let _silenceFrameB64 = null;
function sendSilenceFrame() {
  if (!liveWebSocket || liveWebSocket.readyState !== WebSocket.OPEN) return;
  if (_toolCallPending) return; // Don't send audio during tool execution (causes 1008)

  try {
    if (!_silenceFrameB64) {
      const silence = new Uint8Array(2048);
      let binary = "";
      for (let i = 0; i < silence.length; i++) binary += String.fromCharCode(silence[i]);
      _silenceFrameB64 = btoa(binary);
    }

    const msg = JSON.stringify({
      realtimeInput: {
        mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: _silenceFrameB64 }],
      },
    });

    if (liveWebSocket.readyState === WebSocket.OPEN) {
      liveWebSocket.send(msg);
    }
  } catch (err) {
    console.warn("[VOICE] Error sending silence to WebSocket", { error: err.message });
  }
}

function flushAiAudio() {
  for (const src of activeAudioSources) {
    try { src.stop(); } catch (_) { /* already stopped */ }
  }
  activeAudioSources = [];
  nextPlaybackTime = 0;
  isAiSpeaking = false;
}

function emitAudioState(palette) {
  _onAudioState?.({ isAiSpeaking, isMicMuted, palette });
}

// ═══════════════════════════════════════════════════════════════
// Silence detection
// ═══════════════════════════════════════════════════════════════

function touchActivity() {
  lastActivityTime = Date.now();
  silenceAskedOnce = false;
  silenceWarnedOnce = false;
}

function startSilenceChecker() {
  stopSilenceChecker();
  lastActivityTime = Date.now();
  silenceAskedOnce = false;
  silenceWarnedOnce = false;

  silenceCheckInterval = setInterval(() => {
    if (!isSessionActive || !liveWebSocket || liveWebSocket.readyState !== WebSocket.OPEN) return;

    const elapsed = Date.now() - lastActivityTime;

    if (elapsed >= SILENCE_AUTO_END_MS) {
      console.info("[Voice] Stopping session due to silence timeout");
      stopSession({ full: true, reason: "silence_timeout" });
      return;
    }

    if (elapsed >= SILENCE_WARN_MS && !silenceWarnedOnce) {
      silenceWarnedOnce = true;
      sendTextToModel("The user has been silent for a while now. Gently let them know that the call will end soon if they don't respond. Say something brief like 'I'll let you go if you're busy, just say something if you want to keep talking.'");
      return;
    }

    if (elapsed >= SILENCE_ASK_MS && !silenceAskedOnce) {
      silenceAskedOnce = true;
      sendTextToModel("The user has been silent for 30 seconds. Gently check if they're still there. Say something brief and natural like 'Hey, you still there?' or 'I'm here whenever you're ready.'");
    }
  }, 5000);
}

function stopSilenceChecker() {
  if (silenceCheckInterval) {
    clearInterval(silenceCheckInterval);
    silenceCheckInterval = null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Network connectivity monitoring
// ═══════════════════════════════════════════════════════════════

function startNetworkMonitor() {
  stopNetworkMonitor();
  _lastWsMessageTime = Date.now();

  const onOffline = () => {
    if (!isSessionActive) return;
    console.warn("[Voice] Browser went offline");
    _onTranscript?.("ai", "\n[Connection lost — trying to reconnect...]\n");
  };

  const onOnline = () => {
    if (!isSessionActive) return;
    console.log("[Voice] Browser back online");
    _onTranscript?.("ai", "\n[Connection restored]\n");
  };

  window.addEventListener("offline", onOffline);
  window.addEventListener("online", onOnline);
  _networkHandlers = { onOffline, onOnline };

  // Check for stale WebSocket every 15s — if no data received in 30s,
  // the connection is likely dead but the browser hasn't detected it yet
  _networkCheckInterval = setInterval(() => {
    if (!isSessionActive || !liveWebSocket) return;
    const elapsed = Date.now() - _lastWsMessageTime;
    if (elapsed > 30_000 && liveWebSocket.readyState === WebSocket.OPEN) {
      console.warn("[Voice] WebSocket appears stale — no data for 30s");
      _onTranscript?.("ai", "\n[Connection seems unstable — call may end if it doesn't recover]\n");
      _lastWsMessageTime = Date.now(); // prevent spamming
    }
  }, 15_000);
}

function stopNetworkMonitor() {
  if (_networkHandlers) {
    window.removeEventListener("offline", _networkHandlers.onOffline);
    window.removeEventListener("online", _networkHandlers.onOnline);
    _networkHandlers = null;
  }
  if (_networkCheckInterval) {
    clearInterval(_networkCheckInterval);
    _networkCheckInterval = null;
  }
}

