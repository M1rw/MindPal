export const VOICE_INPUT_MIME_TYPE = "audio/pcm;rate=16000";
export const VOICE_OUTPUT_MIME_TYPE = "audio/pcm;rate=24000";

export const VOICE_V4_INPUT_MIME_TYPE = VOICE_INPUT_MIME_TYPE;
export const VOICE_V4_OUTPUT_MIME_TYPE = VOICE_OUTPUT_MIME_TYPE;

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Build the BidiGenerateContent setup message.
 *
 * @param {object} options
 * @param {string} options.model
 * @param {string} options.voiceName  - Prebuilt voice name (e.g. "Kore")
 * @param {string} options.instruction - System instruction text
 * @param {boolean} [options.useClientVad=false]
 *   When true: disables server-side VAD so the client sends explicit
 *   activityStart / activityEnd signals. This cuts interruption latency
 *   from ~300 ms (network RTT) to near-zero.
 */
export function buildSetupEnvelope({
  model = "models/gemini-2.5-flash-native-audio-latest",
  voiceName = "Kore",
  instruction = "You are MindPal. Respond naturally and concisely in audio.",
  useClientVad = false,
} = {}) {
  if (typeof instruction !== "string" || instruction.trim().length === 0) {
    throw new TypeError("instruction must be a non-empty string");
  }
  if (typeof voiceName !== "string" || voiceName.trim().length === 0) {
    throw new TypeError("voiceName must be a non-empty string");
  }
  return {
    setup: {
      model,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voiceName.trim(),
            },
          },
        },
        thinkingConfig: {
          thinkingBudget: 0,
        },
      },
      systemInstruction: {
        parts: [{ text: instruction.trim() }],
      },
      realtimeInputConfig: {
        automaticActivityDetection: { disabled: useClientVad === true },
      },
    },
  };
}

/**
 * Build a realtimeInput audio frame envelope.
 * @param {string} base64Pcm16 - Base64-encoded PCM16LE audio
 */
export function buildRealtimeInputEnvelope(base64Pcm16) {
  if (!isValidBase64(base64Pcm16)) {
    throw new TypeError("PCM data must be valid base64");
  }
  return {
    realtimeInput: {
      audio: {
        mimeType: VOICE_INPUT_MIME_TYPE,
        data: base64Pcm16,
      },
    },
  };
}

/**
 * Notify the server that the user has started speaking.
 * Only sent when useClientVad = true (server VAD disabled).
 */
export function buildActivityStartEnvelope() {
  return { realtimeInput: { activityStart: {} } };
}

/**
 * Notify the server that the user has stopped speaking.
 * Only sent when useClientVad = true (server VAD disabled).
 */
export function buildActivityEndEnvelope() {
  return { realtimeInput: { activityEnd: {} } };
}

export function isValidBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) {
    return false;
  }
  return BASE64_PATTERN.test(value);
}

export function isValidAudioPart(part) {
  if (!part || typeof part !== "object") return false;
  const inline = part.inlineData;
  if (!inline || typeof inline !== "object") return false;
  if (inline.mimeType !== VOICE_OUTPUT_MIME_TYPE) return false;
  return isValidBase64(inline.data);
}

export function validateInputPcmFrame(chunk) {
  if (!(chunk instanceof Uint8Array)) {
    throw new TypeError("PCM frame must be a Uint8Array");
  }
  if (chunk.byteLength === 0 || chunk.byteLength % 2 !== 0) {
    throw new RangeError("PCM frame must contain non-empty 16-bit samples");
  }
  return {
    sampleRateHz: 16000,
    sampleCount: chunk.byteLength / 2,
    bytes: chunk,
  };
}

export function validateOutputPcmChunk(chunk) {
  if (!(chunk instanceof Uint8Array)) {
    throw new TypeError("PCM chunk must be a Uint8Array");
  }
  if (chunk.byteLength === 0 || chunk.byteLength % 2 !== 0) {
    throw new RangeError("PCM chunk must contain non-empty 16-bit samples");
  }
  return {
    sampleRateHz: 24000,
    sampleCount: chunk.byteLength / 2,
    bytes: chunk,
  };
}
