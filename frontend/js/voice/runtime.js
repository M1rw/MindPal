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
  HOLDING_PHASE_MS,
  TURN_COMPLETE_DELAY_MS,
  TURN_COMPLETE_GRACE_MS,
} from "./constants.js";
import { buildAdaptiveVoicePrompt, inferEmotionHint } from "./prompts.js";
import { createToolExecutor, getToolDeclarations } from "./tools.js";
import {
  buildEphemeralVoiceWebSocketUrl,
  classifySocketClose,
  fetchVoiceTokenWithRetry,
} from "./startup_helpers.mjs";

const INPUT_SAMPLE_RATE = 16_000;
const OUTPUT_SAMPLE_RATE = 24_000;
const CAPTURE_FRAME_SIZE = 2_048;
const SILENCE_FRAME_INTERVAL_MS = 280;
const MAX_RECONNECT_ATTEMPTS = 4;
const RECONNECT_BASE_DELAY_MS = 450;

export function createVoiceSessionController() {
  const state = {
    liveWebSocket: null,
    audioContext: null,
    micSource: null,
    mediaStream: null,
    workletNode: null,
    scriptProcessorNode: null,
    captureSinkNode: null,
    isSessionActive: false,
    isStopping: false,
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
    bargeInStartedAt: 0,
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
    _refreshAuthToken: null,
    _getAppCheckToken: null,
    _refreshAppCheckToken: null,
    _onTranscript: null,
    _onAudioState: null,
    _onSessionEnd: null,
    _onVolume: null,
    _onTurnComplete: null,
    _lastUserTranscript: "",
    _lastAiTranscript: "",
    _recentEmotionHint: "neutral",
    _silenceFrameB64: null,
    _lastSilenceFrameAt: 0,
    _voiceCredentials: null,
    _sessionResumptionHandle: "",
    _goAwayTimer: null,
    _setupComplete: false,
    _greetingSent: false,
    _socketGeneration: 0,
    _reconnectTimer: null,
    _reconnectAttempts: 0,
  };

  const toolExecutor = createToolExecutor({
    getAuthToken: () => state._authToken,
    getAppCheckToken: () => state._getAppCheckToken?.(),
    contextProvider: () => state._contextProvider,
    apiBaseUrl: () => window.MINDPAL_CONFIG?.API_BASE_URL || "",
  });

  function debugLog(message, payload = {}) {
    if (!window.MINDPAL_CONFIG?.VOICE_DEBUG) return;
    console.debug(`[VOICE][DEBUG] ${message}`, payload);
  }

  function setSessionPhase(phase, extra = {}) {
    state.sessionPhase = phase;
    state._onAudioState?.({
      phase,
      isAiSpeaking: state.isAiSpeaking,
      isMicMuted: state.isMicMuted,
      palette: phase === "speaking" ? "speak" : "listen",
      reconnectAttempt: state._reconnectAttempts,
      ...extra,
    });
  }

  function clearTurnCompleteTimer() {
    if (!state.userTurnCompleteTimer) return;
    clearTimeout(state.userTurnCompleteTimer);
    state.userTurnCompleteTimer = null;
  }

  function clearListeningTransitionTimer() {
    if (!state.listeningTransitionTimer) return;
    clearTimeout(state.listeningTransitionTimer);
    state.listeningTransitionTimer = null;
  }

  function clearReconnectTimer() {
    if (state._reconnectTimer) {
      clearTimeout(state._reconnectTimer);
      state._reconnectTimer = null;
    }
    if (state._goAwayTimer) {
      clearTimeout(state._goAwayTimer);
      state._goAwayTimer = null;
    }
  }

  function socketIsOpen() {
    return state.liveWebSocket?.readyState === WebSocket.OPEN;
  }

  function sendJson(payload) {
    if (!socketIsOpen()) return false;
    try {
      state.liveWebSocket.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      console.warn("[Voice] Failed to send WebSocket payload:", error);
      return false;
    }
  }

  function floatToPcm16(inputData) {
    const pcm = new Int16Array(inputData.length);
    for (let i = 0; i < inputData.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, inputData[i]));
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return pcm;
  }

  function resampleFloat32(input, fromRate, toRate = INPUT_SAMPLE_RATE) {
    if (!input?.length || !Number.isFinite(fromRate) || fromRate <= 0 || fromRate === toRate) {
      return input instanceof Float32Array ? input : new Float32Array(input || []);
    }

    const outputLength = Math.max(1, Math.round(input.length * toRate / fromRate));
    const output = new Float32Array(outputLength);
    const ratio = fromRate / toRate;

    for (let i = 0; i < outputLength; i += 1) {
      const sourceIndex = i * ratio;
      const left = Math.floor(sourceIndex);
      const right = Math.min(input.length - 1, left + 1);
      const fraction = sourceIndex - left;
      output[i] = input[left] + (input[right] - input[left]) * fraction;
    }

    return output;
  }

  function pcm16ToBase64(pcmData) {
    const bytes = new Uint8Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength);
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  function sendPcmToWebSocket(pcmData) {
    if (!socketIsOpen() || !state._setupComplete || state._toolCallPending) return;
    sendJson({
      realtimeInput: {
        audio: {
          mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
          data: pcm16ToBase64(pcmData),
        },
      },
    });
  }

  function sendSilenceFrame({ force = false } = {}) {
    if (!socketIsOpen() || !state._setupComplete || state._toolCallPending) return;

    const now = Date.now();
    if (!force && now - state._lastSilenceFrameAt < SILENCE_FRAME_INTERVAL_MS) return;
    state._lastSilenceFrameAt = now;

    if (!state._silenceFrameB64) {
      state._silenceFrameB64 = pcm16ToBase64(new Int16Array(1_024));
    }

    sendJson({
      realtimeInput: {
        audio: {
          mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
          data: state._silenceFrameB64,
        },
      },
    });
  }

  function touchActivity() {
    state.lastActivityTime = Date.now();
    state.silenceAskedOnce = false;
    state.silenceWarnedOnce = false;
  }

  function sendTurnComplete() {
    if (!socketIsOpen() || state._toolCallPending) return;
    // Realtime audio uses automatic activity detection; a final silence frame lets
    // the server close the spoken turn without appending an empty client turn.
    sendSilenceFrame({ force: true });
    state.speechSeenRecently = false;
  }

  function noteUserSpeechActivity() {
    state.lastUserSpeechAt = Date.now();
    state.speechSeenRecently = true;
    clearTurnCompleteTimer();

    if (!state.isAiSpeaking && state.sessionPhase !== "interrupting") {
      setSessionPhase("attending");
    }

    const wordCount = (state._lastUserTranscript || "").trim().split(/\s+/).filter(Boolean).length;
    const dynamicDelay = Math.max(TURN_COMPLETE_DELAY_MS - 40, 180)
      + (state._recentEmotionHint === "supportive" ? 35 : 0)
      + (state._recentEmotionHint === "grounded" ? 20 : 0)
      + Math.min(90, wordCount * 5);

    state.userTurnCompleteTimer = setTimeout(() => {
      if (!state.isSessionActive || state.isMicMuted || state._toolCallPending || state.isAiSpeaking) return;
      if (!state.speechSeenRecently) return;
      if (Date.now() - state.lastUserSpeechAt < TURN_COMPLETE_GRACE_MS) return;

      setSessionPhase("holding");
      state.userTurnCompleteTimer = setTimeout(() => {
        if (!state.isSessionActive || state.isMicMuted || state._toolCallPending || state.isAiSpeaking) return;
        sendTurnComplete();
        setSessionPhase("listening");
      }, HOLDING_PHASE_MS);
    }, dynamicDelay);
  }

  function shouldInterruptForBargeIn(rms) {
    const now = Date.now();

    if (rms >= BARGE_IN_FAST_THRESHOLD) {
      state.bargeInStartedAt = now;
      return true;
    }

    if (rms >= BARGE_IN_SUSTAINED_THRESHOLD) {
      if (!state.bargeInStartedAt) state.bargeInStartedAt = now;
      return now - state.bargeInStartedAt >= BARGE_IN_GRACE_MS;
    }

    state.bargeInStartedAt = 0;
    return false;
  }

  function recoverFromInterruption() {
    clearListeningTransitionTimer();
    if (state.isMicMuted || state._toolCallPending || !state.isSessionActive) return;
    setSessionPhase("recovering");
    state.listeningTransitionTimer = setTimeout(() => {
      if (!state.isSessionActive || state._toolCallPending || state.isMicMuted) return;
      setSessionPhase("listening");
    }, 220);
  }

  function flushAiAudio({ updatePhase = true } = {}) {
    for (const source of state.activeAudioSources) {
      try {
        const gainNode = source._gainNode;
        if (gainNode && state.audioContext) {
          const now = state.audioContext.currentTime;
          gainNode.gain.cancelScheduledValues(now);
          gainNode.gain.setValueAtTime(Math.max(0.0001, gainNode.gain.value), now);
          gainNode.gain.linearRampToValueAtTime(0.0001, now + 0.04);
        }
        source.stop(state.audioContext ? state.audioContext.currentTime + 0.04 : undefined);
      } catch {
        // Already stopped.
      }
    }

    state.activeAudioSources = [];
    state.nextPlaybackTime = 0;
    state.isAiSpeaking = false;

    if (updatePhase && state.isSessionActive && !state.isStopping) {
      setSessionPhase(state.isMicMuted ? "muted" : "listening");
    }
  }

  function handleCapturedAudioFrame(rawFrame) {
    if (!state.isSessionActive || state.isMicMuted || !rawFrame?.length) return;

    const sourceRate = state.audioContext?.sampleRate || INPUT_SAMPLE_RATE;
    const inputData = resampleFloat32(rawFrame, sourceRate, INPUT_SAMPLE_RATE);

    let sum = 0;
    for (let i = 0; i < inputData.length; i += 1) sum += inputData[i] * inputData[i];
    const rms = Math.sqrt(sum / Math.max(1, inputData.length));

    if (state.isAiSpeaking && shouldInterruptForBargeIn(rms)) {
      setSessionPhase("interrupting");
      flushAiAudio({ updatePhase: false });
      touchActivity();
      recoverFromInterruption();
    }

    if (rms > ACTIVITY_THRESHOLD) {
      touchActivity();
      noteUserSpeechActivity();
    }

    if (rms > NOISE_GATE_THRESHOLD) {
      state.gateOpenUntil = Date.now() + NOISE_GATE_HOLD_MS;
    }

    const gateOpen = Date.now() < state.gateOpenUntil;
    state._onVolume?.(gateOpen ? rms : 0);

    if (!socketIsOpen()) return;
    if (gateOpen) sendPcmToWebSocket(floatToPcm16(inputData));
    else sendSilenceFrame();
  }

  function startKeepAlive() {
    stopKeepAlive();
    state.keepAliveInterval = setInterval(() => {
      if (!state.isSessionActive || !socketIsOpen()) return;
      if (state._toolCallPending || state.sessionPhase === "speaking") return;
      sendSilenceFrame({ force: true });
    }, 1_800);
  }

  function stopKeepAlive() {
    if (!state.keepAliveInterval) return;
    clearInterval(state.keepAliveInterval);
    state.keepAliveInterval = null;
  }

  function startSilenceChecker() {
    stopSilenceChecker();
    state.lastActivityTime = Date.now();
    state.silenceAskedOnce = false;
    state.silenceWarnedOnce = false;

    state.silenceCheckInterval = setInterval(() => {
      if (!state.isSessionActive || !socketIsOpen()) return;
      const elapsed = Date.now() - state.lastActivityTime;

      if (elapsed >= SILENCE_AUTO_END_MS) {
        stopSession();
        return;
      }

      if (elapsed >= SILENCE_WARN_MS && !state.silenceWarnedOnce) {
        state.silenceWarnedOnce = true;
        sendTextToModel("The user has been silent for a while. Briefly and gently say the call will end soon unless they respond.");
        return;
      }

      if (elapsed >= SILENCE_ASK_MS && !state.silenceAskedOnce) {
        state.silenceAskedOnce = true;
        sendTextToModel("The user has been silent for 30 seconds. Briefly and naturally check whether they are still there.");
      }
    }, 5_000);
  }

  function stopSilenceChecker() {
    if (!state.silenceCheckInterval) return;
    clearInterval(state.silenceCheckInterval);
    state.silenceCheckInterval = null;
  }

  function startNetworkMonitor() {
    stopNetworkMonitor();
    state._lastWsMessageTime = Date.now();

    const onOffline = () => {
      if (!state.isSessionActive) return;
      setSessionPhase("recovering", { connection: "offline" });
    };

    const onOnline = () => {
      if (!state.isSessionActive) return;
      if (!socketIsOpen()) scheduleReconnect("browser-online");
    };

    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    state._networkHandlers = { onOffline, onOnline };

    state._networkCheckInterval = setInterval(() => {
      if (!state.isSessionActive || !state.liveWebSocket) return;
      const elapsed = Date.now() - state._lastWsMessageTime;
      if (elapsed > 45_000 && socketIsOpen()) {
        console.warn("[Voice] WebSocket stale; reconnecting.");
        try { state.liveWebSocket.close(4000, "stale-connection"); } catch {}
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
    const profile = state._contextProvider?.getUserProfile?.() || {};
    const userName = profile.name || "";
    const userGender = profile.gender || "";
    let nameContext = userName ? `\nThe person you are talking to is called ${userName}. Use their name naturally.` : "";
    if (userGender) {
      nameContext += `\nGENDER: The user is ${userGender}. Use correct grammatical gender consistently, especially in Arabic.`;
    }

    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true });
    const dateStr = now.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
    const utcOffset = -now.getTimezoneOffset();
    const offsetHours = Math.floor(Math.abs(utcOffset) / 60);
    const offsetMins = Math.abs(utcOffset) % 60;
    const offsetStr = `UTC${utcOffset >= 0 ? "+" : "-"}${offsetHours}${offsetMins ? `:${String(offsetMins).padStart(2, "0")}` : ""}`;
    const timeContext = `\nCURRENT TIME: ${timeStr}, ${dateStr} (${tzName}, ${offsetStr}). Use current_time for time-sensitive answers.`;

    const adaptivePrompt = buildAdaptiveVoicePrompt(nameContext, timeContext, state);
    const model = state._voiceCredentials?.model;
    if (!model) throw new Error("Voice model configuration is missing.");

    sendJson({
      setup: {
        model: `models/${model.replace(/^models\//, "")}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
        },
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
            endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
            prefixPaddingMs: 100,
            silenceDurationMs: 500,
          },
          activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
          turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY",
        },
        sessionResumption: state._sessionResumptionHandle
          ? { handle: state._sessionResumptionHandle }
          : {},
        contextWindowCompression: { slidingWindow: {} },
        outputAudioTranscription: {},
        inputAudioTranscription: {},
        tools: [{ functionDeclarations: getToolDeclarations() }],
        systemInstruction: { parts: [{ text: adaptivePrompt }] },
      },
    });
  }

  async function handleToolCalls(functionCalls) {
    if (!Array.isArray(functionCalls) || functionCalls.length === 0) return;

    state._toolCallPending = true;
    setSessionPhase("thinking");

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), 15_000);

    try {
      const responses = await Promise.all(functionCalls.map(async (call) => {
        const result = await toolExecutor(call.name, call.args || {}, {
          timeoutMs: 12_000,
          signal: timeoutController.signal,
          allowClientFallback: false,
        });
        return { id: call.id, name: call.name, response: { result } };
      }));
      sendJson({ toolResponse: { functionResponses: responses } });
    } catch (error) {
      console.error("[TOOL_CALL] Batch execution failed:", error);
      const responses = functionCalls.map((call) => ({
        id: call.id,
        name: call.name,
        response: { result: { error: "Tool temporarily unavailable. Continue without it." } },
      }));
      sendJson({ toolResponse: { functionResponses: responses } });
    } finally {
      clearTimeout(timeoutId);
      timeoutController.abort();
      state._toolCallPending = false;
      setSessionPhase(state.isAiSpeaking ? "speaking" : state.isMicMuted ? "muted" : "listening");
    }
  }

  function playAiAudioChunk(base64Data) {
    if (!state.audioContext || !state.isSessionActive || !base64Data) return;

    const audioData = atob(base64Data);
    const sampleCount = Math.floor(audioData.length / 2);
    if (!sampleCount) return;

    const floatBuffer = new Float32Array(sampleCount);
    let sum = 0;
    for (let i = 0; i < sampleCount; i += 1) {
      const lo = audioData.charCodeAt(i * 2);
      const hi = audioData.charCodeAt(i * 2 + 1);
      const unsigned = (hi << 8) | lo;
      const signed = unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned;
      const value = signed / 32768;
      floatBuffer[i] = value;
      sum += value * value;
    }

    state._onVolume?.(Math.sqrt(sum / sampleCount));
    state.isAiSpeaking = true;
    setSessionPhase("speaking");

    const audioBuffer = state.audioContext.createBuffer(1, floatBuffer.length, OUTPUT_SAMPLE_RATE);
    audioBuffer.copyToChannel(floatBuffer, 0);

    const source = state.audioContext.createBufferSource();
    const gainNode = state.audioContext.createGain();
    source.buffer = audioBuffer;
    source.connect(gainNode);
    gainNode.connect(state.outputCompressorNode || state.outputGainNode || state.audioContext.destination);

    const now = state.audioContext.currentTime;
    const cadenceHint = state._recentEmotionHint === "supportive" ? 0.04 : 0.02;
    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.linearRampToValueAtTime(1, now + cadenceHint);

    if (state.nextPlaybackTime < now) state.nextPlaybackTime = now;
    source.start(state.nextPlaybackTime);
    state.nextPlaybackTime += audioBuffer.duration;

    source._gainNode = gainNode;
    state.activeAudioSources.push(source);
    source.onended = () => {
      try { source.disconnect(); } catch {}
      try { gainNode.disconnect(); } catch {}
      state.activeAudioSources = state.activeAudioSources.filter((item) => item !== source);
      if (state.activeAudioSources.length === 0) {
        state.isAiSpeaking = false;
        if (state.isSessionActive && !state.isStopping) {
          setSessionPhase(state.isMicMuted ? "muted" : "listening");
        }
      }
    };
  }

  function handleServerMessage(data) {
    if (!data || typeof data !== "object") return;

    const resumption = data.sessionResumptionUpdate;
    if (resumption?.resumable && resumption.newHandle) {
      state._sessionResumptionHandle = String(resumption.newHandle);
    }

    if (data.goAway) {
      debugLog("Server requested a resumable reconnect", { timeLeft: data.goAway.timeLeft });
      if (state._sessionResumptionHandle && !state._goAwayTimer) {
        state._goAwayTimer = setTimeout(() => {
          state._goAwayTimer = null;
          if (socketIsOpen()) {
            try { state.liveWebSocket.close(4000, "server-go-away"); } catch {}
          }
        }, 250);
      }
      return;
    }

    if (data.setupComplete) {
      state._setupComplete = true;
      state._reconnectAttempts = 0;
      setSessionPhase(state.isMicMuted ? "muted" : "listening");
      if (!state._greetingSent) {
        state._greetingSent = true;
        sendInitialGreeting();
      }
      return;
    }

    if (data.error) {
      console.error("[Voice] Server error:", data.error);
      state._onTranscript?.("system", "Voice service reported an error.");
      return;
    }

    if (data.serverContent?.modelTurn?.parts) {
      clearTurnCompleteTimer();
      state.speechSeenRecently = false;
      clearListeningTransitionTimer();
      setSessionPhase("preparing");
      for (const part of data.serverContent.modelTurn.parts) {
        if (part.inlineData?.mimeType?.startsWith("audio/pcm")) {
          playAiAudioChunk(part.inlineData.data);
        }
      }
    }

    const outputText = data.serverContent?.outputTranscription?.text;
    if (outputText) {
      state._lastAiTranscript = outputText;
      state._onTranscript?.("ai", outputText);
    }

    const inputText = data.serverContent?.inputTranscription?.text;
    if (inputText) {
      state._lastUserTranscript = inputText;
      state._recentEmotionHint = inferEmotionHint(inputText);
      state._onTranscript?.("user", inputText);
      touchActivity();
    }

    if (data.serverContent?.turnComplete || data.serverContent?.interrupted) {
      clearTurnCompleteTimer();
      state.speechSeenRecently = false;
      if (data.serverContent.interrupted) recoverFromInterruption();
      else setSessionPhase(state.isMicMuted ? "muted" : "listening");
      state._onTurnComplete?.();
    }

    if (data.toolCall?.functionCalls) {
      void handleToolCalls(data.toolCall.functionCalls);
    }
  }

  function sendInitialGreeting() {
    const hour = new Date().getHours();
    const timeContext = hour >= 5 && hour < 12 ? "morning"
      : hour >= 12 && hour < 17 ? "afternoon"
        : hour >= 17 && hour < 21 ? "evening"
          : "late night";
    const userName = state._contextProvider?.getUserProfile?.()?.name || "";
    const nameHint = userName ? ` Their name is ${userName}.` : "";
    sendTextToModel(`Give a warm, natural one-sentence greeting. It is ${timeContext}.${nameHint} Then wait for the user.`);
  }

  async function refreshVoiceCredentials() {
    if (typeof state._refreshAuthToken === "function") {
      const refreshed = await state._refreshAuthToken();
      if (refreshed) state._authToken = refreshed;
    }

    const baseUrl = window.MINDPAL_CONFIG?.API_BASE_URL || "";
    const appCheckToken = typeof state._getAppCheckToken === "function"
      ? await state._getAppCheckToken()
      : null;
    const credentials = await fetchVoiceTokenWithRetry({
      baseUrl,
      token: state._authToken,
      appCheckToken,
      refreshToken: async () => {
        if (typeof state._refreshAuthToken !== "function") return state._authToken;
        const refreshed = await state._refreshAuthToken();
        if (refreshed) state._authToken = refreshed;
        return state._authToken;
      },
      refreshAppCheckToken: async () => {
        if (typeof state._refreshAppCheckToken !== "function") {
          return typeof state._getAppCheckToken === "function" ? state._getAppCheckToken() : null;
        }
        return state._refreshAppCheckToken();
      },
      maxAttempts: 3,
    });

    state._voiceCredentials = credentials;
    return credentials;
  }

  function openWebSocket(credentials, { reconnecting = false } = {}) {
    if (!state.isSessionActive || state.isStopping) return;

    clearReconnectTimer();
    state._setupComplete = false;
    const generation = ++state._socketGeneration;
    const socket = new WebSocket(buildEphemeralVoiceWebSocketUrl(credentials));
    state.liveWebSocket = socket;
    setSessionPhase(reconnecting ? "recovering" : "connecting");

    socket.onopen = () => {
      if (generation !== state._socketGeneration || !state.isSessionActive) return;
      state._lastWsMessageTime = Date.now();
      try {
        sendSetupMessage();
      } catch (error) {
        console.error("[Voice] Failed to configure Live session:", error);
        try { socket.close(1011, "setup-failed"); } catch {}
        return;
      }
      startSilenceChecker();
      startKeepAlive();
      startNetworkMonitor();
      touchActivity();
    };

    socket.onmessage = async (event) => {
      if (generation !== state._socketGeneration || !state.isSessionActive) return;
      try {
        const raw = event.data instanceof Blob ? await event.data.text() : event.data;
        const data = typeof raw === "string" ? JSON.parse(raw) : raw;
        state._lastWsMessageTime = Date.now();
        handleServerMessage(data);
      } catch (error) {
        console.warn("[Voice] Ignored malformed WebSocket message:", error);
      }
    };

    socket.onerror = (error) => {
      if (generation !== state._socketGeneration || !state.isSessionActive) return;
      console.warn("[Voice] WebSocket error:", error);
      setSessionPhase("recovering");
    };

    socket.onclose = (event) => {
      if (generation !== state._socketGeneration) return;
      if (state.liveWebSocket === socket) state.liveWebSocket = null;
      if (!state.isSessionActive || state.isStopping) return;

      const classification = classifySocketClose({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        hasSetupComplete: state._setupComplete,
        greetingSent: state._greetingSent,
      });

      if (classification.retryable) {
        scheduleReconnect(classification.reason);
      } else {
        console.warn(`[Voice] Session ended after socket close: ${classification.reason}`);
        stopSession();
      }
    };
  }


  function scheduleReconnect(reason = "transient") {
    if (!state.isSessionActive || state.isStopping || state._reconnectTimer) return;

    if (state._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error("[Voice] Reconnect attempts exhausted.");
      stopSession();
      return;
    }

    state._reconnectAttempts += 1;
    const delay = Math.min(6_000, RECONNECT_BASE_DELAY_MS * (2 ** (state._reconnectAttempts - 1)));
    setSessionPhase("recovering", { reconnectReason: reason, reconnectInMs: delay });

    state._reconnectTimer = setTimeout(async () => {
      state._reconnectTimer = null;
      if (!state.isSessionActive || state.isStopping) return;

      try {
        // A consumed one-use token can reconnect only when a session handle exists.
        // Otherwise provision a fresh token and start a new Live session.
        if (!state._sessionResumptionHandle || !state._voiceCredentials) {
          state._sessionResumptionHandle = "";
          await refreshVoiceCredentials();
        }
        openWebSocket(state._voiceCredentials, { reconnecting: true });
      } catch (error) {
        console.warn("[Voice] Reconnect credential refresh failed:", error);
        scheduleReconnect("credential-refresh-failed");
      }
    }, delay);
  }

  async function setupAudioCapture() {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) throw new Error("This browser does not support Web Audio.");
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser does not support microphone access.");

    state.audioContext = new AudioContextCtor({ latencyHint: "interactive" });
    if (state.audioContext.state === "suspended") await state.audioContext.resume();

    try {
      state.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (error) {
      if (error?.name === "NotAllowedError") {
        throw new Error("Microphone permission denied. Allow microphone access and retry.");
      }
      throw error;
    }

    state.mediaStream.getAudioTracks().forEach((track) => {
      track.onended = () => {
        if (state.isSessionActive && !state.isStopping) stopSession();
      };
    });

    state.micSource = state.audioContext.createMediaStreamSource(state.mediaStream);
    state.micAnalyser = state.audioContext.createAnalyser();
    state.micAnalyser.fftSize = 2_048;
    state.micAnalyser.smoothingTimeConstant = 0.8;
    state.micSource.connect(state.micAnalyser);

    state.captureSinkNode = state.audioContext.createGain();
    state.captureSinkNode.gain.value = 0;
    state.captureSinkNode.connect(state.audioContext.destination);

    try {
      const workletUrl = new URL("/js/voice/pcm_capture_worklet.js", window.location.origin);
      await state.audioContext.audioWorklet.addModule(workletUrl.href);
      state.workletNode = new AudioWorkletNode(state.audioContext, "mindpal-pcm-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { frameSize: CAPTURE_FRAME_SIZE },
      });
      state.workletNode.port.onmessage = (event) => handleCapturedAudioFrame(event.data);
      state.micSource.connect(state.workletNode);
      state.workletNode.connect(state.captureSinkNode);
    } catch (error) {
      console.warn("[Voice] AudioWorklet unavailable; using ScriptProcessor fallback:", error);
      if (!state.audioContext.createScriptProcessor) {
        throw new Error("No supported microphone capture path is available in this browser.");
      }
      state.scriptProcessorNode = state.audioContext.createScriptProcessor(CAPTURE_FRAME_SIZE, 1, 1);
      state.scriptProcessorNode.onaudioprocess = (event) => {
        const channel = event.inputBuffer.getChannelData(0);
        handleCapturedAudioFrame(new Float32Array(channel));
      };
      state.micSource.connect(state.scriptProcessorNode);
      state.scriptProcessorNode.connect(state.captureSinkNode);
    }

    state.aiAnalyser = state.audioContext.createAnalyser();
    state.aiAnalyser.fftSize = 2_048;
    state.aiAnalyser.smoothingTimeConstant = 0.75;

    state.outputCompressorNode = state.audioContext.createDynamicsCompressor();
    state.outputCompressorNode.threshold.value = -24;
    state.outputCompressorNode.knee.value = 28;
    state.outputCompressorNode.ratio.value = 8;
    state.outputCompressorNode.attack.value = 0.002;
    state.outputCompressorNode.release.value = 0.2;

    state.outputGainNode = state.audioContext.createGain();
    state.outputGainNode.gain.value = state.isSpeakerMuted ? 0 : 1;

    state.outputCompressorNode.connect(state.aiAnalyser);
    state.aiAnalyser.connect(state.outputGainNode);
    state.outputGainNode.connect(state.audioContext.destination);
  }

  async function startSession({
    contextProvider = null,
    onTranscript = null,
    onAudioState = null,
    onSessionEnd = null,
    onVolume = null,
    onTurnComplete = null,
    token = null,
    refreshAuthToken = null,
    getAppCheckToken = null,
    refreshAppCheckToken = null,
  } = {}) {
    if (state.isSessionActive) return false;

    state._contextProvider = contextProvider;
    state._authToken = token;
    state._refreshAuthToken = refreshAuthToken;
    state._getAppCheckToken = getAppCheckToken;
    state._refreshAppCheckToken = refreshAppCheckToken;
    state._onTranscript = onTranscript;
    state._onAudioState = onAudioState;
    state._onSessionEnd = onSessionEnd;
    state._onVolume = onVolume;
    state._onTurnComplete = onTurnComplete;
    state._lastUserTranscript = "";
    state._lastAiTranscript = "";
    state._recentEmotionHint = "neutral";
    state._voiceCredentials = null;
    state._sessionResumptionHandle = "";
    state._setupComplete = false;
    state._greetingSent = false;
    state._reconnectAttempts = 0;
    state._socketGeneration = 0;
    state._lastSilenceFrameAt = 0;
    state.isSessionActive = true;
    state.isStopping = false;
    state.isMicMuted = false;
    state.isSpeakerMuted = false;
    state.isAiSpeaking = false;
    state.nextPlaybackTime = 0;
    state.activeAudioSources = [];
    state.gateOpenUntil = 0;
    state.bargeInStartedAt = 0;
    state.speechSeenRecently = false;
    state.lastUserSpeechAt = 0;
    clearTurnCompleteTimer();
    clearListeningTransitionTimer();
    clearReconnectTimer();
    setSessionPhase("connecting");

    try {
      // Ask for microphone permission first so the one-minute token start window
      // is not consumed while the browser is waiting on the user.
      await setupAudioCapture();
      await refreshVoiceCredentials();
      openWebSocket(state._voiceCredentials);
      return true;
    } catch (error) {
      cleanupResources({ notify: false });
      throw error;
    }
  }

  function cleanupResources({ notify = true } = {}) {
    const shouldNotify = notify && state.isSessionActive;
    state.isStopping = true;
    state.isSessionActive = false;
    state._socketGeneration += 1;

    clearTurnCompleteTimer();
    clearListeningTransitionTimer();
    clearReconnectTimer();
    stopSilenceChecker();
    stopKeepAlive();
    stopNetworkMonitor();
    flushAiAudio({ updatePhase: false });

    if (state.liveWebSocket) {
      const socket = state.liveWebSocket;
      state.liveWebSocket = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try { socket.close(1000, "client-stop"); } catch {}
    }

    if (state.workletNode) {
      state.workletNode.port.onmessage = null;
      try { state.workletNode.disconnect(); } catch {}
      state.workletNode = null;
    }
    if (state.scriptProcessorNode) {
      state.scriptProcessorNode.onaudioprocess = null;
      try { state.scriptProcessorNode.disconnect(); } catch {}
      state.scriptProcessorNode = null;
    }
    if (state.captureSinkNode) {
      try { state.captureSinkNode.disconnect(); } catch {}
      state.captureSinkNode = null;
    }
    if (state.micAnalyser) {
      try { state.micAnalyser.disconnect(); } catch {}
      state.micAnalyser = null;
    }
    if (state.aiAnalyser) {
      try { state.aiAnalyser.disconnect(); } catch {}
      state.aiAnalyser = null;
    }
    if (state.outputCompressorNode) {
      try { state.outputCompressorNode.disconnect(); } catch {}
      state.outputCompressorNode = null;
    }
    if (state.outputGainNode) {
      try { state.outputGainNode.disconnect(); } catch {}
      state.outputGainNode = null;
    }
    if (state.micSource) {
      try { state.micSource.disconnect(); } catch {}
      state.micSource = null;
    }
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach((track) => {
        track.onended = null;
        track.stop();
      });
      state.mediaStream = null;
    }
    if (state.audioContext && state.audioContext.state !== "closed") {
      void state.audioContext.close().catch(() => {});
    }
    state.audioContext = null;

    state._authToken = null;
    state._refreshAuthToken = null;
    state._getAppCheckToken = null;
    state._refreshAppCheckToken = null;
    state._voiceCredentials = null;
    state._sessionResumptionHandle = "";
    state._setupComplete = false;
    state._toolCallPending = false;
    state.sessionPhase = "idle";
    state.isStopping = false;

    if (shouldNotify) state._onSessionEnd?.();
  }

  function stopSession() {
    if (!state.isSessionActive && !state.isStopping) return;
    cleanupResources({ notify: true });
  }

  function setMuted(muted) {
    state.isMicMuted = Boolean(muted);
    state.mediaStream?.getAudioTracks().forEach((track) => {
      track.enabled = !state.isMicMuted;
    });

    setSessionPhase(state.isMicMuted ? "muted" : state.isAiSpeaking ? "speaking" : "listening");

    if (state.isMicMuted && socketIsOpen() && !state._toolCallPending) {
      sendJson({ realtimeInput: { audioStreamEnd: true } });
      state.speechSeenRecently = false;
      clearTurnCompleteTimer();
    }
  }

  function setSpeakerMuted(muted) {
    state.isSpeakerMuted = Boolean(muted);
    if (state.outputGainNode && state.audioContext) {
      state.outputGainNode.gain.setValueAtTime(state.isSpeakerMuted ? 0 : 1, state.audioContext.currentTime);
    }
  }

  function sendTextToModel(text) {
    const clean = String(text || "").trim();
    if (!clean || !state._setupComplete) return false;
    return sendJson({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: clean }] }],
        turnComplete: true,
      },
    });
  }

  function getSessionState() {
    return {
      isActive: state.isSessionActive,
      isMicMuted: state.isMicMuted,
      isAiSpeaking: state.isAiSpeaking,
      isSpeakerMuted: state.isSpeakerMuted,
      phase: state.sessionPhase,
      reconnectAttempts: state._reconnectAttempts,
      micAnalyser: state.micAnalyser,
      aiAnalyser: state.aiAnalyser,
    };
  }

  return {
    startSession,
    stopSession,
    setMuted,
    setSpeakerMuted,
    sendTextToModel,
    getSessionState,
    getMicMuted: () => state.isMicMuted,
    getAiSpeaking: () => state.isAiSpeaking,
    getSpeakerMuted: () => state.isSpeakerMuted,
  };
}
