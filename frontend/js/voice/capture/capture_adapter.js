function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function floatToPcm16(frame) {
  const source = frame instanceof Float32Array ? frame : Float32Array.from(frame || []);
  const pcm = new Int16Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    pcm[index] = Math.round(clamp(source[index], -1, 1) * 0x7fff);
  }
  return pcm;
}

function toBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  if (typeof btoa === "function") return btoa(binary);
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  throw new Error("No base64 encoder available");
}

export function encodePcm16Base64(frame) {
  const pcm = floatToPcm16(frame);
  return toBase64(new Uint8Array(pcm.buffer));
}

export function createCaptureAdapter({
  onAudio = () => {},
  onQuality = () => {},
  sampleRate = 16000,
  now = () => Date.now(),
} = {}) {
  let muted = false;
  let active = false;
  let frameCount = 0;
  let startedAt = 0;

  function start() {
    active = true;
    startedAt = now();
    return true;
  }

  function stop() {
    active = false;
    return true;
  }

  function setMuted(nextMuted) {
    muted = Boolean(nextMuted);
  }

  function processFrame(frame, metadata = {}) {
    if (!active || muted) return false;
    const source = frame instanceof Float32Array ? frame : Float32Array.from(frame || []);
    if (source.length === 0) return false;
    const rms = Math.sqrt(source.reduce((sum, value) => sum + (value * value), 0) / source.length);
    frameCount += 1;
    onQuality({
      rms,
      frameCount,
      activeMs: Math.max(0, now() - startedAt),
      ...metadata,
    });
    onAudio({
      base64Data: encodePcm16Base64(source),
      mimeType: `audio/pcm;rate=${sampleRate}`,
      frameCount,
      at: now(),
    });
    return true;
  }

  return Object.freeze({
    start,
    stop,
    setMuted,
    processFrame,
    isActive: () => active,
    isMuted: () => muted,
    getFrameCount: () => frameCount,
  });
}
