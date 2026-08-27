import {
  VOICE_V4_CONTRACT,
  VOICE_V4_CONTRACT_VERSION,
} from "../layer0/contract.js";

const MAX_INSTRUCTION_CHARS = 8_000;
const MAX_VOICE_NAME_CHARS = 80;
const PCM16_BYTES_PER_SAMPLE = 2;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const VOICE_V4_PROTOCOL_VERSION = "v1beta";
export const VOICE_V4_INPUT_MIME_TYPE = "audio/pcm;rate=16000";
export const VOICE_V4_OUTPUT_MIME_TYPE = "audio/pcm;rate=24000";

export function buildSetupEnvelope({ instruction, voiceName }) {
  const safeInstruction = requireText(instruction, "instruction", MAX_INSTRUCTION_CHARS);
  const safeVoiceName = requireVoiceName(voiceName);

  return {
    setup: {
      model: VOICE_V4_CONTRACT.model,
      generationConfig: {
        responseModalities: [VOICE_V4_CONTRACT.responseModality],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: safeVoiceName },
          },
        },
      },
      systemInstruction: { parts: [{ text: safeInstruction }] },
      realtimeInputConfig: {
        automaticActivityDetection: { disabled: false },
      },
    },
  };
}

export function buildRealtimeInputEnvelope(base64Pcm16) {
  const data = requireBase64(base64Pcm16);
  return {
    realtimeInput: {
      audio: {
        mimeType: VOICE_V4_INPUT_MIME_TYPE,
        data,
      },
    },
  };
}

export function validateInputPcmFrame(bytes) {
  return validatePcm(bytes, VOICE_V4_CONTRACT.inputAudio.sampleRateHz, "input");
}

export function validateOutputPcmChunk(bytes) {
  return validatePcm(bytes, VOICE_V4_CONTRACT.outputAudio.sampleRateHz, "output");
}

export function isValidAudioPart(part) {
  return Boolean(
    part &&
      typeof part === "object" &&
      part.inlineData &&
      typeof part.inlineData === "object" &&
      part.inlineData.mimeType === VOICE_V4_OUTPUT_MIME_TYPE &&
      typeof part.inlineData.data === "string" &&
      isValidBase64(part.inlineData.data),
  );
}

export function isValidBase64(value) {
  return typeof value === "string" && value.length > 0 && value.length % 4 === 0 && BASE64_PATTERN.test(value);
}

function validatePcm(bytes, sampleRateHz, direction) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(`${direction} PCM must be a Uint8Array`);
  }
  if (bytes.byteLength === 0 || bytes.byteLength % PCM16_BYTES_PER_SAMPLE !== 0) {
    throw new RangeError(`${direction} PCM must contain complete PCM16 samples`);
  }
  return {
    bytes: new Uint8Array(bytes),
    encoding: VOICE_V4_CONTRACT.inputAudio.encoding,
    sampleRateHz,
    channels: VOICE_V4_CONTRACT.inputAudio.channels,
    contractVersion: VOICE_V4_CONTRACT_VERSION,
  };
}

function requireText(value, name, maximum) {
  if (typeof value !== "string") throw new TypeError(`${name} must be text`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum) throw new RangeError(`${name} is outside the allowed range`);
  return trimmed;
}

function requireVoiceName(value) {
  const name = requireText(value, "voiceName", MAX_VOICE_NAME_CHARS);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) throw new RangeError("voiceName contains unsupported characters");
  return name;
}

function requireBase64(value) {
  if (!isValidBase64(value)) throw new TypeError("PCM payload must be valid base64");
  return value;
}
