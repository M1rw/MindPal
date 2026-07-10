import {
  ACTIVITY_THRESHOLD,
  BARGE_IN_FAST_THRESHOLD,
  BARGE_IN_GRACE_MS,
  BARGE_IN_SUSTAINED_THRESHOLD,
  NOISE_GATE_HOLD_MS,
  NOISE_GATE_THRESHOLD,
  SILENCE_ASK_MS,
  SILENCE_AUTO_END_MS,
  SILENCE_WARN_MS,
  ATTENDING_PHASE_MS,
  HOLDING_PHASE_MS,
  TURN_COMPLETE_DELAY_MS,
  TURN_COMPLETE_GRACE_MS,
} from "./constants.js";
import { buildAdaptiveVoicePrompt, inferEmotionHint } from "./prompts.js";
import { createToolExecutor, getToolDeclarations } from "./tools.js";
import { classifySocketClose, fetchVoiceKeyWithRetry } from "./startup_helpers.mjs";

export function createVoiceSessionController() {
  const state = {
    liveWebSocket: null,
    audioContext: null,
    micSource: null,
    mediaStream: null,
    workletNode: null,
    isSessionActive: false,
    isMicMuted: false,
    isSpeakerMuted: false,
    isAiSpeaking: false,
    sessionPhase: "idle",
    nextPlaybackTime: 0,
    activeAudioSources: [],
    outputGainNode: null,
    outputCompressorNode: null,
    _toolCallPending: false,
    gateOpenUntil: 0,
    lastBargeInAt: 0,
    bargeInIgnoreUntil: 0,
    userTurnCompleteTimer: null,
    lastUserSpeechAt: 0,
    speechSeenRecently: false,
    lastActivityTime: 0,
    silenceCheckInterval: null,
    keepAliveInterval: null,
    listeningTransitionTimer: null,
    silenceAskedOnce: false,
    silenceWarnedOnce: false,
    _networkHandlers: null,
    _lastWsMessageTime: 0,
    _networkCheckInterval: null,
    micAnalyser: null,
    aiAnalyser: null,
    _contextProvider: null,
    _authToken: null,
    _onTranscript: null,
    _onAudioState: null,
    _onSessionEnd: null,
    _onVolume: null,
    _onTurnComplete: null,
    _lastUserTranscript: "",
    _lastAiTranscript: "",
    _recentEmotionHint: "neutral",
    _silenceFrameB64: null,
  };

  const toolExecutor = createToolExecutor({
    getAuthToken: () => state._authToken,
    contextProvider: () => state._contextProvider,
    apiBaseUrl: () => window.MINDPAL_CONFIG?.API_BASE_URL || "",
  });

  function debugLog(message, payload = {}) {
    console.debug(`[VOICE][DEBUG] ${message}`, payload);
  }

  function clearTurnCompleteTimer() {
    if (state.userTurnCompleteTimer) {
      debugLog("Clearing turn-complete timer");
      clearTimeout(state.userTurnCompleteTimer);
      state.userTurnCompleteTimer = null;
    }
  }

  function clearListeningTransitionTimer() {
    if (state.listeningTransitionTimer) {
      debugLog("Clearing listening transition timer");
      clearTimeout(state.listeningTransitionTimer);
      state.listeningTransitionTimer = null;
    }
  }

  function noteUserSpeechActivity() {
    state.lastUserSpeechAt = Date.now();
    state.speechSeenRecently = true;
    debugLog("User speech activity detected", { phase: state.sessionPhase });
    clearTurnCompleteTimer();
    if (state.sessionPhase !== "attending" && state.sessionPhase !== "interrupting" && !state.isAiSpeaking) {
      setSessionPhase("attending");
    }

    const lastUserWords = (state._lastUserTranscript || "").trim().split(/\s+/).filter(Boolean).length;
    const dynamicDelay = Math.max(TURN_COMPLETE_DELAY_MS - 40, 180) + (state._recentEmotionHint === "supportive" ? 35 : 0) + (state._recentEmotionHint === "grounded" ? 20 : 0) + Math.min(90, lastUserWords * 5);
    state.userTurnCompleteTimer = setTimeout(() => {
      if (!state.isSessionActive || state.isMicMuted || state._toolCallPending || state.isAiSpeaking) return;
      const elapsed = Date.now() - state.lastUserSpeechAt;
      if (elapsed < TURN_COMPLETE_GRACE_MS) return;
      if (!state.speechSeenRecently) return;
      setSessionPhase("holding");
      setTimeout(() => {
        if (!state.isSessionActive || state.isMicMuted || state._toolCallPending || state.isAiSpeaking) return;
        // Explicit turnComplete removed to avoid WebSocket 1007 errors; relying on server-side VAD
        state.speechSeenRecently = false;
        setSessionPhase("listening");
      }, HOLDING_PHASE_MS);
    }, dynamicDelay);
  }

  function shouldInterruptForBargeIn(rms) {
    const now = Date.now();
    if (now < state.bargeInIgnoreUntil) return false;

    if (rms >= BARGE_IN_FAST_THRESHOLD) {
      state.lastBargeInAt = now;
      return true;
    }
    // Sustained speech detection: requires significant volume over a duration
    if (rms >= BARGE_IN_SUSTAINED_THRESHOLD && now - state.lastBargeInAt > BARGE_IN_GRACE_MS) {
      state.lastBargeInAt = now;
      return true;
    }
    return false;
  }

  function recoverFromInterruption() {
    clearListeningTransitionTimer();
    if (state.isMicMuted || state._toolCallPending) return;
    debugLog("Recovering from interruption", { phase: state.sessionPhase });
    setSessionPhase("recovering");
    state.listeningTransitionTimer = setTimeout(() => {
      if (!state.isSessionActive || state._toolCallPending || state.isMicMuted) return;
      setSessionPhase("listening");
    }, 220);
  }

  function setSessionPhase(phase) {
    state.sessionPhase = phase;
    debugLog("Session phase changed", { phase, isAiSpeaking: state.isAiSpeaking, isMicMuted: state.isMicMuted });
    state._onAudioState?.({
      phase,
      isAiSpeaking: state.isAiSpeaking,
      isMicMuted: state.isMicMuted,
      palette: phase === "speaking" ? "speak" : "listen",
    });
  }

  function emitAudioState(palette) {
    state._onAudioState?.({
      phase: state.sessionPhase,
      isAiSpeaking: state.isAiSpeaking,
      isMicMuted: state.isMicMuted,
      palette,
    });
  }

  function flushAiAudio() {
    for (const src of state.activeAudioSources) {
      try {
        const gainNode = src._gainNode;
        if (gainNode && state.audioContext) {
          gainNode.gain.cancelScheduledValues(state.audioContext.currentTime);
          gainNode.gain.setValueAtTime(gainNode.gain.value, state.audioContext.currentTime);
          gainNode.gain.linearRampToValueAtTime(0.0001, state.audioContext.currentTime + 0.05);
        }
        src.stop(state.audioContext?.currentTime ? state.audioContext.currentTime + 0.05 : undefined);
      } catch (_) {}
    }
    state.activeAudioSources = [];
    state.nextPlaybackTime = 0;
    state.isAiSpeaking = false;
    debugLog("Flushed AI audio", { activeSources: 0 });
    if (!state.isMicMuted) setSessionPhase("listening");
  }

  function sendPcmToWebSocket(pcmData) {
    if (!state.liveWebSocket || state.liveWebSocket.readyState !== WebSocket.OPEN) return;
    if (state._toolCallPending) return;

    const buffer = new ArrayBuffer(pcmData.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < pcmData.length; i++) view.setInt16(i * 2, pcmData[i], true);

    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);

    debugLog("Sending PCM audio chunk to WebSocket", { bytes: pcmData.length });
    state.liveWebSocket.send(JSON.stringify({
      realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: btoa(binary) }] },
    }));
  }

  function sendSilenceFrame() {
    if (!state.liveWebSocket || state.liveWebSocket.readyState !== WebSocket.OPEN) return;
    if (state._toolCallPending) return;

    if (!state._silenceFrameB64) {
      // 8192 bytes = 4096 samples at 16-bit depth (2 bytes per sample)
      const silence = new Uint8Array(8192);
      let binary = "";
      for (let i = 0; i < silence.length; i++) binary += String.fromCharCode(silence[i]);
      state._silenceFrameB64 = btoa(binary);
    }

    debugLog("Sending silence frame to WebSocket");
    state.liveWebSocket.send(JSON.stringify({
      realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: state._silenceFrameB64 }] },
    }));
  }

  function touchActivity() {
    state.lastActivityTime = Date.now();
    state.silenceAskedOnce = false;
    state.silenceWarnedOnce = false;
  }

  function startKeepAlive() {
    stopKeepAlive();
    state.keepAliveInterval = setInterval(() => {
      if (!state.isSessionActive || !state.liveWebSocket || state.liveWebSocket.readyState !== WebSocket.OPEN) return;
      if (state._toolCallPending || state.isMicMuted || state.sessionPhase === "speaking") return;
      sendSilenceFrame();
    }, 1_800);
  }

  function stopKeepAlive() {
    if (state.keepAliveInterval) {
      clearInterval(state.keepAliveInterval);
      state.keepAliveInterval = null;
    }
  }

  function startSilenceChecker() {
    stopSilenceChecker();
    state.lastActivityTime = Date.now();
    state.silenceAskedOnce = false;
    state.silenceWarnedOnce = false;

    state.silenceCheckInterval = setInterval(() => {
      if (!state.isSessionActive || !state.liveWebSocket || state.liveWebSocket.readyState !== WebSocket.OPEN) return;
      const elapsed = Date.now() - state.lastActivityTime;

      if (elapsed >= SILENCE_AUTO_END_MS) {
        stopSession();
        return;
      }

      if (elapsed >= SILENCE_WARN_MS && !state.silenceWarnedOnce) {
        state.silenceWarnedOnce = true;
        sendTextToModel("The user has been silent for a while now. Gently let them know that the call will end soon if they don't respond. Say something brief like 'I'll let you go if you're busy, just say something if you want to keep talking.'");
        return;
      }

      if (elapsed >= SILENCE_ASK_MS && !state.silenceAskedOnce) {
        state.silenceAskedOnce = true;
        sendTextToModel("The user has been silent for 30 seconds. Gently check if they're still there. Say something brief and natural like 'Hey, you still there?' or 'I'm here whenever you're ready.'");
      }
    }, 5000);
  }

  function stopSilenceChecker() {
    if (state.silenceCheckInterval) {
      clearInterval(state.silenceCheckInterval);
      state.silenceCheckInterval = null;
    }
  }

  function startNetworkMonitor() {
    stopNetworkMonitor();
    state._lastWsMessageTime = Date.now();

    const onOffline = () => {
      if (!state.isSessionActive) return;
      console.warn("[Voice] Browser went offline");
      state._onTranscript?.("ai", "\n[Connection lost — trying to reconnect...]\n");
    };

    const onOnline = () => {
      if (!state.isSessionActive) return;
      console.log("[Voice] Browser back online");
      state._onTranscript?.("ai", "\n[Connection restored]\n");
    };

    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    state._networkHandlers = { onOffline, onOnline };

    state._networkCheckInterval = setInterval(() => {
      if (!state.isSessionActive || !state.liveWebSocket) return;
      const elapsed = Date.now() - state._lastWsMessageTime;
      if (elapsed > 30_000 && state.liveWebSocket.readyState === WebSocket.OPEN) {
        console.warn("[Voice] WebSocket appears stale — no data for 30s");
        state._onTranscript?.("ai", "\n[Connection seems unstable — call may end if it doesn't recover]\n");
        state._lastWsMessageTime = Date.now();
      }
    }, 15_000);
  }

  function stopNetworkMonitor() {
    if (state._networkHandlers) {
      window.removeEventListener("offline", state._networkHandlers.onOffline);
      window.removeEventListener("online", state._networkHandlers.onOnline);
      state._networkHandlers = null;
    }
    if (state._networkCheckInterval) {
      clearInterval(state._networkCheckInterval);
      state._networkCheckInterval = null;
    }
  }

  function sendSetupMessage() {
    debugLog("Sending Gemini setup message");
    const profile = state._contextProvider?.getUserProfile?.() || {};
    const userName = profile.name || "";
    const userGender = profile.gender || "";
    let nameContext = userName ? `\nThe person you are talking to is called ${userName}. Use their name naturally.` : "";
    if (userGender) {
      nameContext += `\nGENDER: The user is ${userGender}. This is critical for Arabic and other gendered languages — use correct grammatical gender consistently (masculine/feminine verbs, adjectives, pronouns).`;
    }

    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
    const dateStr = now.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
    const utcOffset = -now.getTimezoneOffset();
    const offsetHours = Math.floor(Math.abs(utcOffset) / 60);
    const offsetMins = Math.abs(utcOffset) % 60;
    const offsetStr = `UTC${utcOffset >= 0 ? '+' : '-'}${offsetHours}${offsetMins ? ':' + String(offsetMins).padStart(2, '0') : ''}`;
    const timeContext = `\nCURRENT TIME: ${timeStr}, ${dateStr} (${tzName}, ${offsetStr}). If the user asks about time, use the current_time tool for the most accurate answer.`;

    const adaptivePrompt = buildAdaptiveVoicePrompt(nameContext, timeContext, state);
    state.liveWebSocket.send(JSON.stringify({
      setup: {
        model: "models/gemini-2.5-flash-native-audio-latest",
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
        },
        outputAudioTranscription: {},
        inputAudioTranscription: {},
        tools: [{ functionDeclarations: getToolDeclarations() }],
        systemInstruction: { parts: [{ text: adaptivePrompt }] },
      },
    }));
  }

  function handleToolCalls(functionCalls) {
    state._toolCallPending = true;
    debugLog("Handling tool calls", { count: functionCalls?.length || 0 });
    setSessionPhase("thinking");
    const batchTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Tool batch timeout")), 15_000));
    const batchExecution = Promise.all(functionCalls.map(async (call) => {
      const result = await toolExecutor(call.name, call.args || {});
      return { id: call.id, name: call.name, response: { result } };
    }));

    Promise.race([batchExecution, batchTimeout])
      .then((resolvedResponses) => {
        if (state.liveWebSocket?.readyState === WebSocket.OPEN) {
          state.liveWebSocket.send(JSON.stringify({ toolResponse: { functionResponses: resolvedResponses } }));
        }
        state._toolCallPending = false;
        if (state.isAiSpeaking) {
          setSessionPhase("speaking");
        } else {
          setSessionPhase(state.isMicMuted ? "muted" : "listening");
        }
      })
      .catch((err) => {
        console.error("[TOOL_CALL] Batch execution failed:", err.message);
        const errorResponses = functionCalls.map((call) => ({
          id: call.id,
          name: call.name,
          response: { result: { error: "Tool temporarily unavailable — please respond without this tool" } },
        }));
        if (state.liveWebSocket?.readyState === WebSocket.OPEN) {
          state.liveWebSocket.send(JSON.stringify({ toolResponse: { functionResponses: errorResponses } }));
        }
        state._toolCallPending = false;
        if (state.isAiSpeaking) {
          setSessionPhase("speaking");
        } else {
          setSessionPhase(state.isMicMuted ? "muted" : "listening");
        }
      });
  }

  function playAiAudioChunk(base64Data) {
    if (!state.audioContext || !state.isSessionActive) return;

    debugLog("Playing AI audio chunk", { bytes: base64Data?.length || 0 });
    state.isAiSpeaking = true;
    setSessionPhase("speaking");

    const audioData = atob(base64Data);
    const pcmBuffer = new Int16Array(audioData.length / 2);
    for (let i = 0; i < pcmBuffer.length; i++) {
      pcmBuffer[i] = (audioData.charCodeAt(i * 2 + 1) << 8) | audioData.charCodeAt(i * 2);
    }

    const floatBuffer = new Float32Array(pcmBuffer.length);
    for (let i = 0; i < pcmBuffer.length; i++) floatBuffer[i] = pcmBuffer[i] / 32768.0;

    let aiSum = 0;
    for (let i = 0; i < floatBuffer.length; i++) aiSum += floatBuffer[i] * floatBuffer[i];
    state._onVolume?.(Math.sqrt(aiSum / floatBuffer.length));

    const audioBuffer = state.audioContext.createBuffer(1, floatBuffer.length, 24000);
    audioBuffer.getChannelData(0).set(floatBuffer);

    const source = state.audioContext.createBufferSource();
    source.buffer = audioBuffer;

    const cadenceHint = state._recentEmotionHint === "playful" ? 0.02 : state._recentEmotionHint === "supportive" ? 0.045 : state._recentEmotionHint === "grounded" ? 0.028 : 0.032;
    const gainNode = state.audioContext.createGain();
    gainNode.gain.setValueAtTime(0.0001, state.audioContext.currentTime);
    gainNode.gain.linearRampToValueAtTime(1.0, state.audioContext.currentTime + cadenceHint);

    if (state.aiAnalyser) {
      source.connect(gainNode);
      gainNode.connect(state.outputCompressorNode || state.outputGainNode || state.audioContext.destination);
      state.outputCompressorNode?.connect(state.aiAnalyser);
      state.aiAnalyser.connect(state.outputGainNode || state.audioContext.destination);
    } else {
      source.connect(gainNode);
      gainNode.connect(state.outputCompressorNode || state.outputGainNode || state.audioContext.destination);
    }

    if (state.nextPlaybackTime < state.audioContext.currentTime) {
      state.nextPlaybackTime = state.audioContext.currentTime;
    }
    source.start(state.nextPlaybackTime);
    state.nextPlaybackTime += audioBuffer.duration;

    source._gainNode = gainNode;
    state.activeAudioSources.push(source);
    source.onended = () => {
      state.activeAudioSources = state.activeAudioSources.filter((s) => s !== source);
      if (state.activeAudioSources.length === 0 && state.audioContext.currentTime >= state.nextPlaybackTime) {
        state.isAiSpeaking = false;
        setSessionPhase(state.isMicMuted ? "muted" : "listening");
      }
    };
  }

  function handleServerMessage(data) {
    if (data.setupComplete) {
      debugLog("Gemini setup complete — ready to receive audio");
      sendInitialGreeting();
      return;
    }

    if (data.error) {
      console.error("[Voice] Server error:", data.error);
      debugLog("Voice server error", { error: data.error });
      return;
    }

    if (data.serverContent?.modelTurn) {
      clearTurnCompleteTimer();
      state.speechSeenRecently = false;
      clearListeningTransitionTimer();
      if (!state.isAiSpeaking) {
        setSessionPhase("preparing");
        // Give AI 250ms of 'protection' when it starts a new turn
        state.bargeInIgnoreUntil = Date.now() + 250;
      }
      debugLog("Model turn received", { parts: data.serverContent.modelTurn.parts?.length || 0 });
      for (const part of data.serverContent.modelTurn.parts) {
        if (part.inlineData?.mimeType?.startsWith("audio/pcm")) {
          playAiAudioChunk(part.inlineData.data);
        }
      }
    }

    if (data.serverContent?.outputTranscription?.text) {
      const text = data.serverContent.outputTranscription.text;
      debugLog("AI transcription received", { text });
      state._lastAiTranscript = text;
      state._onTranscript?.("ai", text);
    }

    if (data.serverContent?.inputTranscription?.text) {
      const text = data.serverContent.inputTranscription.text;
      debugLog("User transcription received", { text });
      state._lastUserTranscript = text;
      state._recentEmotionHint = inferEmotionHint(text);
      state._onTranscript?.("user", text);
      touchActivity();
    }

    if (data.serverContent?.turnComplete || data.serverContent?.interrupted) {
      debugLog("Turn event received", { turnComplete: Boolean(data.serverContent?.turnComplete), interrupted: Boolean(data.serverContent?.interrupted) });
      clearTurnCompleteTimer();
      state.speechSeenRecently = false;
      if (data.serverContent?.interrupted) {
        flushAiAudio();
        recoverFromInterruption();
      } else if (!state.isAiSpeaking) {
        setSessionPhase(state.isMicMuted ? "muted" : "listening");
      }
      state._onTurnComplete?.();
    }

    if (data.toolCall?.functionCalls) {
      handleToolCalls(data.toolCall.functionCalls);
    }
  }

  function sendInitialGreeting() {
    if (!state.liveWebSocket || state.liveWebSocket.readyState !== WebSocket.OPEN) return;

    const hour = new Date().getHours();
    let timeContext;
    if (hour >= 5 && hour < 12) timeContext = "morning";
    else if (hour >= 12 && hour < 17) timeContext = "afternoon";
    else if (hour >= 17 && hour < 21) timeContext = "evening";
    else timeContext = "late night";

    const userName = state._contextProvider?.getUserProfile?.()?.name || "";
    const nameHint = userName ? ` Their name is ${userName}.` : "";
    const mood = state._recentEmotionHint || "neutral";
    const moodHint = {
      supportive: "Be soft and gentle.",
      playful: "Be lightly playful.",
      grounded: "Be calm and grounded.",
      neutral: "Be warm and relaxed.",
    }[mood] || "Be warm and relaxed.";

    const styles = [
      `Greet the user warmly. It's ${timeContext}.${nameHint} Keep it short and natural — 1 sentence max. Then wait for them to talk. ${moodHint}`,
      `Say a casual, friendly hello. It's ${timeContext}.${nameHint} Don't be formal. Just a quick natural greeting like you're picking up a phone call with a close friend. ${moodHint}`,
      `Start the conversation with a warm check-in. It's ${timeContext}.${nameHint} Ask how they're doing in a genuine way. One sentence only. ${moodHint}`,
      `Open with something light and natural. It's ${timeContext}.${nameHint} Maybe comment on the time of day briefly. Keep it very short. ${moodHint}`,
    ];
    const prompt = styles[Math.floor(Math.random() * styles.length)];
    debugLog("Sending initial greeting prompt", { prompt });
    sendTextToModel(prompt);
  }

  async function startSession({
    contextProvider = null,
    onTranscript = null,
    onAudioState = null,
    onSessionEnd = null,
    onVolume = null,
    onTurnComplete = null,
    token = null,
  } = {}) {
    if (state.isSessionActive) return;

    debugLog("Starting voice session", { hasToken: Boolean(token) });
    state._contextProvider = contextProvider;
    state._authToken = token;
    state._onTranscript = onTranscript;
    state._onAudioState = onAudioState;
    state._onSessionEnd = onSessionEnd;
    state._onVolume = onVolume;
    state._onTurnComplete = onTurnComplete || null;
    state._lastUserTranscript = "";
    state._lastAiTranscript = "";
    state._recentEmotionHint = "neutral";

    state.isSessionActive = true;
    state.isMicMuted = false;
    state.isSpeakerMuted = false;
    state.isAiSpeaking = false;
    state.sessionPhase = "connecting";
    state.nextPlaybackTime = 0;
    state.activeAudioSources = [];
    state.gateOpenUntil = 0;
    state.lastBargeInAt = 0;
    state.speechSeenRecently = false;
    state.lastUserSpeechAt = 0;
    clearTurnCompleteTimer();

    const baseUrl = window.MINDPAL_CONFIG?.API_BASE_URL || "";
    let key = "";
    try {
      debugLog("Fetching voice key", { baseUrl });
    const keyResponse = await fetchVoiceKeyWithRetry({
        baseUrl,
        token,
        refreshToken: async () => token || null,
      });
      key = keyResponse?.key || "";
    } catch (error) {
      console.error("[VOICE] Failed to fetch voice key:", error);
      throw new Error("Voice service is currently unavailable. Please try again in a moment.");
    }

    if (!key) {
      throw new Error("Voice service is currently unavailable. Please try again in a moment.");
    }

    if (!window.AudioContext && !window.webkitAudioContext) {
      throw new Error("This browser does not support the Web Audio API required for voice.");
    }

    debugLog("Creating audio context");
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    state.audioContext = new AudioContextCtor({ sampleRate: 16000, latencyHint: "interactive" });
    if (state.audioContext.state === "suspended") {
      await state.audioContext.resume().catch(err => console.warn("[Voice] Failed to resume audio context:", err));
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support microphone access.");
    }

    try {
      debugLog("Requesting microphone access");
      state.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 16000,
        },
      });
    } catch (err) {
      if (err.name === "NotAllowedError") {
        throw new Error("Microphone permission denied. Please allow mic access in your browser settings.");
      }
      throw err;
    }

    debugLog("Microphone stream acquired", { tracks: state.mediaStream.getAudioTracks().length });
    state.mediaStream.getAudioTracks().forEach(track => {
      track.onended = () => {
        console.warn("[Voice] Mic track ended unexpectedly");
        if (state.isSessionActive) stopSession();
      };
    });

    state.micSource = state.audioContext.createMediaStreamSource(state.mediaStream);

    try {
      const workletCode = `
    class PCMProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.buffer = new Float32Array(2048);
        this.ptr = 0;
        this.smoothRms = 0.0001;
        this.gain = 1.0;
      }

      process(inputs) {
        const ch = inputs[0]?.[0];
        if (!ch) return true;

        for (let i = 0; i < ch.length; i++) {
          let sample = ch[i];
          const abs = Math.abs(sample);
          this.smoothRms = this.smoothRms * 0.84 + abs * 0.16;
          // High-speed gain adaptation for ultra-responsive duplex performance
          const targetGain = abs < 0.001 ? 0.0 : Math.min(2.4, 1.0 / Math.max(0.1, this.smoothRms * 1.5));
          this.gain = this.gain * 0.5 + targetGain * 0.5;
          sample = sample * this.gain;
          sample = Math.max(-1, Math.min(1, sample));
          if (abs < 0.0003) sample = 0;
          this.buffer[this.ptr++] = sample;
          if (this.ptr >= 2048) {
            this.port.postMessage(this.buffer);
            this.ptr = 0;
            this.buffer = new Float32Array(2048);
          }
        }
        return true;
      }
    }
    registerProcessor('pcm-processor', PCMProcessor);
    `;
      const blob = new Blob([workletCode], { type: "application/javascript" });
      debugLog("Loading audio worklet");
      await state.audioContext.audioWorklet.addModule(URL.createObjectURL(blob));
      state.workletNode = new AudioWorkletNode(state.audioContext, "pcm-processor");
    } catch (err) {
      console.warn("[VOICE] Audio worklet unavailable, falling back to simpler capture:", err);
      state.workletNode = null;
    }

    if (state.workletNode) {
      state.workletNode.port.onmessage = (e) => {
        if (!state.isSessionActive || !state.liveWebSocket || state.liveWebSocket.readyState !== WebSocket.OPEN) return;

        const inputData = e.data;
        const pcmData = new Int16Array(inputData.length);
      let sum = 0;
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        sum += s * s;
      }

        const rms = Math.sqrt(sum / inputData.length);
        if (!state.isMicMuted && shouldInterruptForBargeIn(rms) && state.isAiSpeaking) {
          setSessionPhase("interrupting");
          flushAiAudio();
          recoverFromInterruption();
          touchActivity();
        }

        if (!state.isMicMuted && rms > ACTIVITY_THRESHOLD) {
          touchActivity();
          noteUserSpeechActivity();
        }

        if (!state.isMicMuted) {
          if (rms > NOISE_GATE_THRESHOLD) {
            state.gateOpenUntil = Date.now() + NOISE_GATE_HOLD_MS;
          }
          const gateOpen = Date.now() < state.gateOpenUntil;
          state._onVolume?.(gateOpen ? rms : 0);
          if (gateOpen) sendPcmToWebSocket(pcmData); else sendSilenceFrame();
        }
      };

      state.micSource.connect(state.workletNode);
    }
    state.micAnalyser = state.audioContext.createAnalyser();
    state.micAnalyser.fftSize = 2048;
    state.micAnalyser.smoothingTimeConstant = 0.8;
    state.micSource.connect(state.micAnalyser);

    state.aiAnalyser = state.audioContext.createAnalyser();
    state.aiAnalyser.fftSize = 2048;
    state.aiAnalyser.smoothingTimeConstant = 0.75;

    state.outputGainNode = state.audioContext.createGain();
    state.outputGainNode.gain.value = 1.0;
    state.outputCompressorNode = state.audioContext.createDynamicsCompressor();
    state.outputCompressorNode.threshold.value = -24;
    state.outputCompressorNode.knee.value = 28;
    state.outputCompressorNode.ratio.value = 8;
    state.outputCompressorNode.attack.value = 0.002;
    state.outputCompressorNode.release.value = 0.2;
    state.outputCompressorNode.connect(state.outputGainNode);
    state.outputGainNode.connect(state.audioContext.destination);

    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${key}`;
    debugLog("Opening WebSocket", { wsUrl });
    state.liveWebSocket = new WebSocket(wsUrl);

    state.liveWebSocket.onopen = () => {
      debugLog("WebSocket opened");
      setSessionPhase("listening");
      sendSetupMessage();
      startSilenceChecker();
      startKeepAlive();
      startNetworkMonitor();
      touchActivity();
    };

    state.liveWebSocket.onmessage = async (event) => {
      debugLog("WebSocket message received", { type: typeof event.data });
      let data;
      if (event.data instanceof Blob) {
        data = JSON.parse(await event.data.text());
      } else {
        data = JSON.parse(event.data);
      }
      handleServerMessage(data);
      state._lastWsMessageTime = Date.now();
    };

    state.liveWebSocket.onerror = (err) => {
      console.error("[Voice] WebSocket error:", err);
      debugLog("WebSocket error", { err });
      stopSession();
    };

    state.liveWebSocket.onclose = (event) => {
      console.warn(`[Voice] WebSocket closed — code: ${event.code}, reason: "${event.reason}", wasClean: ${event.wasClean}`);
      debugLog("WebSocket closed", { code: event.code, reason: event.reason, wasClean: event.wasClean });
      const classification = classifySocketClose({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        hasSetupComplete: state.sessionPhase !== "connecting",
        greetingSent: state._lastAiTranscript !== "" || state._lastUserTranscript !== "",
      });

      if (state.isSessionActive && classification.shouldStop) {
        stopSession();
      } else if (state.isSessionActive && classification.retryable) {
        console.warn(`[VOICE] Treating close as transient (${classification.reason}) — keeping session alive for a retry`);
      }
    };
  }

  function stopSession() {
    if (!state.isSessionActive) return;
    state.isSessionActive = false;
    debugLog("Stopping voice session");

    clearTurnCompleteTimer();
    clearListeningTransitionTimer();
    flushAiAudio();
    stopSilenceChecker();
    stopKeepAlive();
    stopNetworkMonitor();
    if (state.workletNode) { state.workletNode.disconnect(); state.workletNode = null; }
    if (state.micAnalyser) { state.micAnalyser.disconnect(); state.micAnalyser = null; }
    if (state.aiAnalyser) { state.aiAnalyser.disconnect(); state.aiAnalyser = null; }
    if (state.outputCompressorNode) { state.outputCompressorNode.disconnect(); state.outputCompressorNode = null; }
    if (state.outputGainNode) { state.outputGainNode.disconnect(); state.outputGainNode = null; }
    if (state.micSource) { state.micSource.disconnect(); state.micSource = null; }
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach(track => track.stop());
      state.mediaStream = null;
    }
    if (state.audioContext && state.audioContext.state !== "closed") { state.audioContext.close(); state.audioContext = null; }
    if (state.liveWebSocket) { state.liveWebSocket.close(); state.liveWebSocket = null; }
    state._authToken = null;
    state._onSessionEnd?.();
  }

  function setMuted(muted) {
    state.isMicMuted = muted;
    setSessionPhase(muted ? "muted" : state.isAiSpeaking ? "speaking" : "listening");
    if (muted && state.liveWebSocket?.readyState === WebSocket.OPEN && !state._toolCallPending) {
      for (let i = 0; i < 3; i++) sendSilenceFrame();
      // Explicit turnComplete removed to avoid WebSocket 1007 errors; relying on server-side VAD
    }
    state._onAudioState?.({
      phase: state.sessionPhase,
      isAiSpeaking: state.isAiSpeaking,
      isMicMuted: state.isMicMuted,
      palette: state.isAiSpeaking ? "speak" : "listen",
    });
  }

  function setSpeakerMuted(muted) {
    state.isSpeakerMuted = muted;
    if (state.outputGainNode) {
      state.outputGainNode.gain.setValueAtTime(muted ? 0 : 1, state.audioContext?.currentTime || 0);
    }
  }

  function sendTextToModel(text) {
    if (!state.liveWebSocket || state.liveWebSocket.readyState !== WebSocket.OPEN) return;
    state.liveWebSocket.send(JSON.stringify({
      clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true },
    }));
  }

  function getSessionState() {
    return {
      isActive: state.isSessionActive,
      isMicMuted: state.isMicMuted,
      isAiSpeaking: state.isAiSpeaking,
      micAnalyser: state.micAnalyser,
      aiAnalyser: state.aiAnalyser,
    };
  }

  function getMicMuted() { return state.isMicMuted; }
  function getAiSpeaking() { return state.isAiSpeaking; }
  function getSpeakerMuted() { return state.isSpeakerMuted; }

  return {
    startSession,
    stopSession,
    setMuted,
    setSpeakerMuted,
    sendTextToModel,
    getSessionState,
    getMicMuted,
    getAiSpeaking,
    getSpeakerMuted,
  };
}
