export const CAPTURE_ERROR_CODES = Object.freeze({
  INSECURE_CONTEXT: "insecure_context",
  MEDIA_DEVICES_UNAVAILABLE: "media_devices_unavailable",
  AUDIO_CONTEXT_UNAVAILABLE: "audio_context_unavailable",
  AUDIO_WORKLET_UNAVAILABLE: "audio_worklet_unavailable",
  PERMISSION_DENIED: "permission_denied",
  DEVICE_NOT_FOUND: "device_not_found",
  DEVICE_UNREADABLE: "device_unreadable",
  CONSTRAINT_FAILED: "constraint_failed",
  CAPTURE_UNAVAILABLE: "capture_unavailable",
});

export function inspectCaptureCapabilities({
  secureContext = globalThis.isSecureContext,
  mediaDevices = globalThis.navigator?.mediaDevices,
  AudioContextConstructor = globalThis.AudioContext || globalThis.webkitAudioContext,
  AudioWorkletNodeConstructor = globalThis.AudioWorkletNode,
} = {}) {
  if (secureContext !== true) return capabilityFailure(CAPTURE_ERROR_CODES.INSECURE_CONTEXT);
  if (!mediaDevices || typeof mediaDevices.getUserMedia !== "function") return capabilityFailure(CAPTURE_ERROR_CODES.MEDIA_DEVICES_UNAVAILABLE);
  if (typeof AudioContextConstructor !== "function") return capabilityFailure(CAPTURE_ERROR_CODES.AUDIO_CONTEXT_UNAVAILABLE);
  if (typeof AudioWorkletNodeConstructor !== "function") return capabilityFailure(CAPTURE_ERROR_CODES.AUDIO_WORKLET_UNAVAILABLE);

  return Object.freeze({
    available: true,
    errorCode: null,
    hasMediaDevices: true,
    hasAudioContext: true,
    hasAudioWorkletNode: true,
  });
}

export function mapCaptureError(error) {
  const name = typeof error?.name === "string" ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return CAPTURE_ERROR_CODES.PERMISSION_DENIED;
    case "NotFoundError":
      return CAPTURE_ERROR_CODES.DEVICE_NOT_FOUND;
    case "NotReadableError":
    case "AbortError":
      return CAPTURE_ERROR_CODES.DEVICE_UNREADABLE;
    case "OverconstrainedError":
      return CAPTURE_ERROR_CODES.CONSTRAINT_FAILED;
    default:
      return CAPTURE_ERROR_CODES.CAPTURE_UNAVAILABLE;
  }
}

export function buildMicrophoneConstraints() {
  return {
    audio: {
      channelCount: { ideal: 1 },
      echoCancellation: { ideal: false },
      noiseSuppression: { ideal: false },
      autoGainControl: { ideal: false },
    },
    video: false,
  };
}

function capabilityFailure(errorCode) {
  return Object.freeze({
    available: false,
    errorCode,
    hasMediaDevices: false,
    hasAudioContext: false,
    hasAudioWorkletNode: false,
  });
}
