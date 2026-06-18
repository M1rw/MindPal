// frontend/js/voice_session.js — WebSocket, audio I/O, tool calls, noise gate

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

const SILENCE_ASK_MS = 30_000;
const SILENCE_WARN_MS = 60_000;
const SILENCE_AUTO_END_MS = 90_000;

// Noise gate: prevents ambient noise from being sent to Gemini
const NOISE_GATE_THRESHOLD = 0.025;
const NOISE_GATE_HOLD_MS = 200;

// Barge-in: user must be louder than this to interrupt AI
const BARGE_IN_THRESHOLD = 0.04;

// Activity detection: user must be louder than this to reset silence timer
const ACTIVITY_THRESHOLD = 0.03;

// ═══════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════

let liveWebSocket = null;
let audioContext = null;
let micSource = null;
let mediaStream = null;
let workletNode = null;

let isSessionActive = false;
let isMicMuted = false;
let isSpeakerMuted = false;
let isAiSpeaking = false;
let nextPlaybackTime = 0;
let activeAudioSources = [];
let outputGainNode = null;

// Noise gate
let gateOpenUntil = 0;

// Silence detection
let lastActivityTime = 0;
let silenceCheckInterval = null;
let silenceAskedOnce = false;
let silenceWarnedOnce = false;

// Analysers (exposed for visualizer)
let micAnalyser = null;
let aiAnalyser = null;

// Context provider (injected by app.js for tool calls)
let _contextProvider = null;

// Callbacks
let _onTranscript = null;   // (type: "user"|"ai", text: string) => void
let _onAudioState = null;   // (state: { isAiSpeaking, isMicMuted, palette }) => void
let _onSessionEnd = null;   // () => void
let _onVolume = null;       // (rms: number) => void

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

  // When muting, we simply stop sending audio frames (handled by the noise gate
  // check `if (!isMicMuted)` in the worklet callback). We do NOT send turnComplete
  // because it can cause Gemini to process incomplete speech and potentially
  // end the session.

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
  token = null,
} = {}) {
  if (isSessionActive) return;

  _contextProvider = contextProvider;
  _onTranscript = onTranscript;
  _onAudioState = onAudioState;
  _onSessionEnd = onSessionEnd;
  _onVolume = onVolume;

  isSessionActive = true;
  isMicMuted = false;
  isSpeakerMuted = false;
  isAiSpeaking = false;
  nextPlaybackTime = 0;
  activeAudioSources = [];
  gateOpenUntil = 0;

  const baseUrl = window.MINDPAL_CONFIG.API_BASE_URL;
  const keyHeaders = {};
  if (token) keyHeaders.Authorization = `Bearer ${token}`;
  const keyRes = await fetch(`${baseUrl}/voice/key`, { headers: keyHeaders });
  if (!keyRes.ok) throw new Error("Failed to fetch API key");
  const { key } = await keyRes.json();

  // Audio context
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  audioContext = new AudioContextCtor({ sampleRate: 16000 });

  // Mic stream
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  micSource = audioContext.createMediaStreamSource(mediaStream);

  // AudioWorklet for PCM capture
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
  workletNode = new AudioWorkletNode(audioContext, "pcm-processor");

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

    // Barge-in: interrupt AI if user speaks loudly enough
    if (!isMicMuted && rms > BARGE_IN_THRESHOLD && isAiSpeaking) {
      flushAiAudio();
      emitAudioState("listen");
    }

    // Activity detection for silence timer
    if (!isMicMuted && rms > ACTIVITY_THRESHOLD) {
      touchActivity();
    }

    // Noise gate: only send audio when above threshold (with hold time)
    if (!isMicMuted) {
      if (rms > NOISE_GATE_THRESHOLD) {
        gateOpenUntil = Date.now() + NOISE_GATE_HOLD_MS;
      }

      const gateOpen = Date.now() < gateOpenUntil;

      _onVolume?.(rms);

      if (gateOpen) {
        sendPcmToWebSocket(pcmData);
      }
    }
  };

  micSource.connect(workletNode);
  workletNode.connect(audioContext.destination);

  // Mic analyser (for visualizer)
  micAnalyser = audioContext.createAnalyser();
  micAnalyser.fftSize = 2048;
  micAnalyser.smoothingTimeConstant = 0.8;
  micSource.connect(micAnalyser);

  // AI output analyser (for visualizer)
  aiAnalyser = audioContext.createAnalyser();
  aiAnalyser.fftSize = 2048;
  aiAnalyser.smoothingTimeConstant = 0.75;

  // Output gain node (for speaker mute)
  outputGainNode = audioContext.createGain();
  outputGainNode.gain.value = 1.0;
  outputGainNode.connect(audioContext.destination);

  // WebSocket to Gemini
  const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${key}`;
  liveWebSocket = new WebSocket(wsUrl);

  liveWebSocket.onopen = () => {
    emitAudioState("listen");
    sendSetupMessage();
    startSilenceChecker();
    touchActivity();
  };

  liveWebSocket.onmessage = async (event) => {
    let data;
    if (event.data instanceof Blob) {
      data = JSON.parse(await event.data.text());
    } else {
      data = JSON.parse(event.data);
    }

    handleServerMessage(data);
  };

  liveWebSocket.onerror = (err) => {
    console.error("Live WebSocket Error", err);
    stopSession();
  };

  liveWebSocket.onclose = (event) => {
    // WebSocket close is expected during stopSession — no debug log needed.
    if (isSessionActive) {
      stopSession();
    }
  };
}

export function stopSession() {
  if (!isSessionActive) return;
  isSessionActive = false;

  flushAiAudio();
  stopSilenceChecker();

  if (workletNode) { workletNode.disconnect(); workletNode = null; }
  if (micAnalyser) { micAnalyser.disconnect(); micAnalyser = null; }
  if (aiAnalyser) { aiAnalyser.disconnect(); aiAnalyser = null; }
  if (outputGainNode) { outputGainNode.disconnect(); outputGainNode = null; }
  if (micSource) { micSource.disconnect(); micSource = null; }
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  if (audioContext && audioContext.state !== "closed") { audioContext.close(); audioContext = null; }
  if (liveWebSocket) { liveWebSocket.close(); liveWebSocket = null; }

  _onSessionEnd?.();
}

export function sendTextToModel(text) {
  if (!liveWebSocket || liveWebSocket.readyState !== WebSocket.OPEN) return;
  liveWebSocket.send(JSON.stringify({
    clientContent: {
      turns: [{ role: "user", parts: [{ text }] }],
      turnComplete: true,
    },
  }));
}

// ═══════════════════════════════════════════════════════════════
// WebSocket setup message
// ═══════════════════════════════════════════════════════════════

function sendSetupMessage() {
  const userName = _contextProvider?.getUserProfile?.()?.name || "";
  const nameContext = userName ? `\nThe person you are talking to is called ${userName}. Use their name naturally.` : "";

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
        parts: [{ text: buildSystemPrompt(nameContext) }],
      },
    },
  }));
}

function getToolDeclarations() {
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
  ];
}

function buildSystemPrompt(nameContext) {
  return `You are MindPal — a real, warm human companion. NOT a robot, NOT an assistant.
${nameContext}
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
- Use their name when appropriate. Remember details from the conversation.

TOOLS:
- You have tools to search the user's memory and chat history. USE THEM proactively.
- When the user asks "do you remember...", "what's my name", "what were we talking about" — ALWAYS call the relevant tool first.
- When greeting the user, you may call get_user_profile to personalize.
- Don't say "I don't have access to that" — you DO have access, use your tools.

MENTAL HEALTH SUPPORT:
- You're supportive but never clinical or robotic about it.
- If someone is struggling, be present with them. Don't immediately jump to solutions.
- Use grounding techniques only when appropriate, and frame them naturally.

LANGUAGE:
- ALWAYS respond in the SAME language the user is speaking. If they speak Arabic, respond in Arabic. If they speak French, respond in French. If they mix languages, match their mix.
- This is critical. Never default to English unless the user speaks English.`;
}

// ═══════════════════════════════════════════════════════════════
// Message handling
// ═══════════════════════════════════════════════════════════════

function handleServerMessage(data) {
  // AI audio chunks
  if (data.serverContent?.modelTurn) {
    for (const part of data.serverContent.modelTurn.parts) {
      if (part.inlineData?.mimeType?.startsWith("audio/pcm")) {
        playAiAudioChunk(part.inlineData.data);
      }
    }
  }

  // AI spoken transcript
  if (data.serverContent?.outputTranscription?.text) {
    _onTranscript?.("ai", data.serverContent.outputTranscription.text);
    touchActivity();
  }

  // User speech transcript
  if (data.serverContent?.inputTranscription?.text) {
    _onTranscript?.("user", data.serverContent.inputTranscription.text);
    touchActivity();
  }

  // Tool calls
  if (data.toolCall?.functionCalls) {
    handleToolCalls(data.toolCall.functionCalls);
  }
}

function playAiAudioChunk(base64Data) {
  if (!audioContext || !isSessionActive) return;

  isAiSpeaking = true;
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
// Tool calls
// ═══════════════════════════════════════════════════════════════

function handleToolCalls(functionCalls) {
  const responses = [];

  // Execute all tool calls concurrently via backend
  Promise.all(
    functionCalls.map(async (call) => {
      // Tool call debug logging removed for production cleanliness.
      const result = await executeToolCall(call.name, call.args || {});
      return { id: call.id, name: call.name, response: { result } };
    })
  ).then((resolvedResponses) => {
    if (liveWebSocket?.readyState === WebSocket.OPEN) {
      liveWebSocket.send(JSON.stringify({ toolResponse: { functionResponses: resolvedResponses } }));
    }
  }).catch((err) => {
    console.error("[TOOL_CALL] Batch execution failed:", err);
    // Send error responses so Gemini doesn't hang
    const errorResponses = functionCalls.map((call) => ({
      id: call.id,
      name: call.name,
      response: { result: { error: "Tool execution failed" } },
    }));
    if (liveWebSocket?.readyState === WebSocket.OPEN) {
      liveWebSocket.send(JSON.stringify({ toolResponse: { functionResponses: errorResponses } }));
    }
  });
}

async function executeToolCall(name, args) {
  // Call backend /api/tools/execute endpoint for server-side tool execution
  const baseUrl = window.MINDPAL_CONFIG?.API_BASE_URL || "";
  const token = _contextProvider?.getAuthToken?.();

  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const response = await fetch(`${baseUrl}/tools/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tool: name, args }),
    });

    if (!response.ok) {
      console.warn(`[TOOL_CALL] ${name} returned HTTP ${response.status}`);
      // Fall back to client-side execution for resilience
      return _executeToolClientSide(name, args);
    }

    const data = await response.json();
    return data.result || data;
  } catch (err) {
    console.warn(`[TOOL_CALL] Backend call failed for ${name}:`, err.message);
    // Fall back to client-side execution for resilience
    return _executeToolClientSide(name, args);
  }
}

function _executeToolClientSide(name, args) {
  // Client-side fallback using _contextProvider (original logic)
  // Used when backend is unreachable
  if (!_contextProvider) return { error: "No context available" };

  switch (name) {
    case "get_user_profile": {
      const profile = _contextProvider.getUserProfile?.() || {};
      return {
        name: profile.name || "unknown",
        preferences: profile.preferences || {},
        communication: profile.communication || {},
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
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ═══════════════════════════════════════════════════════════════
// Audio helpers
// ═══════════════════════════════════════════════════════════════

function sendPcmToWebSocket(pcmData) {
  if (!liveWebSocket || liveWebSocket.readyState !== WebSocket.OPEN) return;

  const buffer = new ArrayBuffer(pcmData.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < pcmData.length; i++) view.setInt16(i * 2, pcmData[i], true);

  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);

  liveWebSocket.send(JSON.stringify({
    realtimeInput: {
      mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: btoa(binary) }],
    },
  }));
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
      stopSession();
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
