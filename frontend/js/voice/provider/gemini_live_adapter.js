import {
  VOICE_EVENTS,
  createProviderAudioEvent,
  createProviderInterruptionEvent,
  createVoiceEvent,
} from "../architecture/events.js";

function decodeMessage(raw) {
  if (typeof raw === "string") return JSON.parse(raw);
  if (raw && typeof raw.data === "string") return JSON.parse(raw.data);
  if (raw && raw.data instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(raw.data));
  if (raw && typeof raw === "object") return raw;
  throw new TypeError("Unsupported Gemini provider message");
}

function decodeSocketMessage(raw) {
  const value = raw?.data ?? raw;
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return value.text().then((text) => JSON.parse(text));
  }
  if (value instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(value));
  if (ArrayBuffer.isView(value)) return JSON.parse(new TextDecoder().decode(value));
  return decodeMessage(raw);
}

function identityFromContext(context = {}) {
  return {
    sessionGeneration: context.sessionGeneration ?? 0,
    turnId: context.turnId ?? null,
    providerResponseId: context.providerResponseId ?? null,
    playbackGeneration: context.playbackGeneration ?? null,
  };
}

export function normalizeGeminiServerMessage(message, context = {}) {
  const data = decodeMessage(message);
  const serverContent = data.serverContent || {};
  const identity = identityFromContext(context);
  const events = [];

  if (data.setupComplete) {
    events.push(createVoiceEvent(VOICE_EVENTS.PROVIDER_READY, { identity, raw: data }));
  }

  const resumptionUpdate = data.sessionResumptionUpdate || data.session_resumption_update;
  if (resumptionUpdate?.newHandle || resumptionUpdate?.new_handle) {
    const handle = String(resumptionUpdate.newHandle || resumptionUpdate.new_handle);
    events.push(createVoiceEvent(VOICE_EVENTS.PROVIDER_RESUMPTION_UPDATED, {
      identity,
      resumeHandle: handle,
      raw: data,
    }));
  }

  if (serverContent.inputTranscription) {
    events.push(createVoiceEvent(VOICE_EVENTS.PROVIDER_INPUT_TRANSCRIPT, {
      identity,
      text: serverContent.inputTranscription.text || "",
      finished: Boolean(serverContent.turnComplete),
      raw: data,
    }));
  }

  if (serverContent.outputTranscription) {
    events.push(createVoiceEvent(VOICE_EVENTS.PROVIDER_OUTPUT_TRANSCRIPT, {
      identity,
      text: serverContent.outputTranscription.text || "",
      finished: Boolean(serverContent.turnComplete),
      raw: data,
    }));
  }

  for (const part of serverContent.modelTurn?.parts || []) {
    const inlineData = part.inlineData || part.inline_data;
    if (inlineData?.data) {
      events.push(createProviderAudioEvent({
        identity,
        base64Data: inlineData.data,
        mimeType: inlineData.mimeType || inlineData.mime_type || "audio/pcm;rate=24000",
      }));
    }
    if (part.functionCall || part.function_call) {
      const functionCall = part.functionCall || part.function_call;
      events.push(createVoiceEvent(VOICE_EVENTS.PROVIDER_TOOL_CALL, {
        identity,
        call: functionCall,
        raw: data,
      }));
    }
  }

  if (serverContent.interrupted === true) {
    events.push(createProviderInterruptionEvent({ identity }));
  }

  if (serverContent.turnComplete === true) {
    events.push(createVoiceEvent(VOICE_EVENTS.PROVIDER_TURN_COMPLETE, { identity, raw: data }));
  }

  if (data.goAway) {
    events.push(createVoiceEvent(VOICE_EVENTS.PROVIDER_GO_AWAY, {
      identity,
      timeLeft: data.goAway.timeLeft || null,
      resumeHandle: context.sessionResumptionHandle || null,
      raw: data,
    }));
  }

  if (data.error) {
    events.push(createVoiceEvent(VOICE_EVENTS.PROVIDER_ERROR, {
      identity,
      error: data.error,
      raw: data,
    }));
  }

  return events;
}

export function createGeminiLiveAdapter({
  WebSocketImpl = globalThis.WebSocket,
  now = () => Date.now(),
  onEvent = () => {},
  onDiagnostic = () => {},
} = {}) {
  let socket = null;
  let connected = false;
  let context = {};
  let sessionResumptionHandle = "";
  let socketGeneration = 0;

  function emit(event) {
    onEvent(Object.freeze({ ...event, at: event.at || now() }));
  }

  function send(payload) {
    if (!socket || socket.readyState !== WebSocketImpl.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }

  function connect({ url, setup, identity = {} } = {}) {
    if (typeof WebSocketImpl !== "function") throw new Error("WebSocket is unavailable");
    if (!url) throw new TypeError("Gemini Live connection requires a URL");
    close(1000, "replaced");
    context = { ...identity, sessionResumptionHandle: "" };
    sessionResumptionHandle = String(identity.sessionResumptionHandle || "");
    socketGeneration += 1;
    const thisSocketGeneration = socketGeneration;
    socket = new WebSocketImpl(url);
    try { socket.binaryType = "arraybuffer"; } catch { /* browser implementation may not expose binaryType */ }
    socket.onopen = () => {
      if (thisSocketGeneration !== socketGeneration) return;
      connected = true;
      const setupSent = setup ? send({ setup }) : false;
      onDiagnostic(Object.freeze({ type: "voice.socket-open", setupSent, at: now() }));
    };
    const handleMessage = (decoded) => {
      if (thisSocketGeneration !== socketGeneration) return;
      const update = decoded.sessionResumptionUpdate || decoded.session_resumption_update;
      if (update?.newHandle || update?.new_handle) sessionResumptionHandle = String(update.newHandle || update.new_handle);
      const eventContext = { ...context, sessionResumptionHandle };
      for (const event of normalizeGeminiServerMessage(decoded, eventContext)) emit(event);
    };
    socket.onmessage = (message) => {
      if (thisSocketGeneration !== socketGeneration) return;
      try {
        const decoded = decodeSocketMessage(message);
        if (decoded?.then) decoded.then(handleMessage).catch((error) => {
          onDiagnostic(Object.freeze({ type: "voice.message-error", message: error?.message || "Malformed provider message", at: now() }));
        });
        else handleMessage(decoded);
      } catch (error) {
        onDiagnostic(Object.freeze({ type: "voice.message-error", message: error?.message || "Malformed provider message", at: now() }));
      }
    };
    socket.onerror = (error) => {
      onDiagnostic(Object.freeze({
        type: "voice.socket-error",
        message: error?.message || "WebSocket error",
        at: now(),
      }));
      emit(createVoiceEvent(VOICE_EVENTS.PROVIDER_ERROR, {
        identity: identityFromContext(context),
        error,
      }));
    };
    socket.onclose = (closeEvent) => {
      if (thisSocketGeneration !== socketGeneration) return;
      connected = false;
      onDiagnostic(Object.freeze({
        type: "voice.socket-closed",
        code: closeEvent?.code ?? null,
        reason: closeEvent?.reason || "closed",
        wasClean: closeEvent?.wasClean === true,
        at: now(),
      }));
      emit(createVoiceEvent(VOICE_EVENTS.PROVIDER_CLOSED, {
        identity: identityFromContext(context),
        code: closeEvent?.code,
        reason: closeEvent?.reason || "closed",
      }));
    };
    return socket;
  }

  function updateContext(nextContext = {}) {
    context = { ...context, ...nextContext };
    if (nextContext.sessionResumptionHandle != null) sessionResumptionHandle = String(nextContext.sessionResumptionHandle || "");
  }

  function sendAudio(base64Data, mimeType = "audio/pcm;rate=16000") {
    return send({ realtimeInput: { audio: { data: base64Data, mimeType } } });
  }

  function sendText(text) {
    if (!text) return false;
    return send({ realtimeInput: { text } });
  }

  function sendClientContent(turns, turnComplete = false) {
    if (!Array.isArray(turns) && !turns) return false;
    return send({ clientContent: { turns: Array.isArray(turns) ? turns : [turns], turnComplete } });
  }

  function sendToolResponse(functionResponses) {
    if (!Array.isArray(functionResponses) || functionResponses.length === 0) return false;
    return send({ toolResponse: { functionResponses } });
  }

  function close(code = 1000, reason = "client-stop") {
    if (!socket) return;
    socketGeneration += 1;
    connected = false;
    try { socket.close(code, reason); } catch { /* already closed */ }
    socket = null;
  }

  return Object.freeze({
    connect,
    close,
    updateContext,
    sendAudio,
    sendText,
    sendClientContent,
    sendToolResponse,
    isConnected: () => connected,
    getSocketGeneration: () => socketGeneration,
    getSessionResumptionHandle: () => sessionResumptionHandle,
  });
}
