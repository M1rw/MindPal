function decodeBase64Pcm16(base64Data) {
  if (!base64Data) return new Int16Array();
  let bytes;
  if (typeof atob === "function") {
    const binary = atob(base64Data);
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  } else if (typeof Buffer !== "undefined") {
    bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
  } else {
    throw new Error("No base64 decoder available");
  }
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}

function pcm16ToFloat32(pcm) {
  const result = new Float32Array(pcm.length);
  for (let index = 0; index < pcm.length; index += 1) result[index] = pcm[index] / 0x8000;
  return result;
}

export function createPlaybackManager({
  audioContext = null,
  onEvent = () => {},
  now = () => Date.now(),
  outputSampleRate = 24000,
  outputAnalyser = null,
} = {}) {
  let activeGeneration = 0;
  let sharedOutputAnalyser = outputAnalyser || (audioContext?.createAnalyser ? audioContext.createAnalyser() : null);
  if (sharedOutputAnalyser) {
    sharedOutputAnalyser.fftSize = sharedOutputAnalyser.fftSize || 256;
    sharedOutputAnalyser.smoothingTimeConstant = 0.82;
    try { sharedOutputAnalyser.connect(audioContext.destination); } catch { /* already connected */ }
  }
  let nextStartTime = 0;
  let playing = false;
  let sources = new Set();
  let muted = false;
  let optimisticallyDucked = false;
  const optimisticDuckGain = 0.12;

  function emit(type, payload = {}) {
    onEvent(Object.freeze({ type, at: now(), ...payload }));
  }

  function setMuted(nextMuted) {
    muted = Boolean(nextMuted);
    for (const entry of sources) {
      const gainNode = entry.gainNode;
      if (!gainNode?.gain) continue;
      const target = muted ? 0 : (optimisticallyDucked ? optimisticDuckGain : entry.baseGain);
      gainNode.gain.setTargetAtTime?.(target, audioContext?.currentTime || 0, 0.025);
      if (!gainNode.gain.setTargetAtTime) gainNode.gain.value = target;
    }
  }

  function setOptimisticDucked(ducked, { rampSeconds = 0.025 } = {}) {
    optimisticallyDucked = Boolean(ducked);
    for (const entry of sources) {
      const gainNode = entry.gainNode;
      if (!gainNode?.gain) continue;
      const target = muted ? 0 : (optimisticallyDucked ? optimisticDuckGain : entry.baseGain);
      gainNode.gain.setTargetAtTime?.(target, audioContext?.currentTime || 0, rampSeconds);
      if (!gainNode.gain.setTargetAtTime) gainNode.gain.value = target;
    }
    emit(optimisticallyDucked ? "playback.ducked" : "playback.unducked", { gain: muted ? 0 : (optimisticallyDucked ? optimisticDuckGain : 1) });
    return optimisticallyDucked;
  }

  function flush({ generation = null, reason = "flush" } = {}) {
    const targetGeneration = generation == null ? activeGeneration : generation;
    for (const source of sources) {
      if (source.generation !== targetGeneration) continue;
      try { source.node.stop(); } catch { /* already ended */ }
      sources.delete(source);
    }
    if (targetGeneration === activeGeneration) {
      activeGeneration += 1;
      nextStartTime = 0;
      playing = false;
    }
    emit("playback.flushed", { generation: targetGeneration, activeGeneration, reason });
    return activeGeneration;
  }

  function beginGeneration(generation = activeGeneration + 1) {
    if (!Number.isInteger(generation) || generation <= activeGeneration) generation = activeGeneration + 1;
    flush({ reason: "new-generation" });
    activeGeneration = generation;
    nextStartTime = 0;
    return activeGeneration;
  }

  function schedule(base64Data, {
    generation = activeGeneration || 1,
    audioClass = "main",
    identity = {},
    gain = audioClass === "main" ? 1 : 0.55,
  } = {}) {
    if (!base64Data || muted) return false;
    if (generation < activeGeneration) return false;
    if (generation > activeGeneration) beginGeneration(generation);
    if (!audioContext || typeof audioContext.createBuffer !== "function") {
      emit("playback.scheduled", { generation, audioClass, identity, durationMs: 0, unavailable: true });
      return true;
    }

    const pcm = decodeBase64Pcm16(base64Data);
    if (pcm.length === 0) return false;
    const samples = pcm16ToFloat32(pcm);
    const buffer = audioContext.createBuffer(1, samples.length, outputSampleRate);
    buffer.copyToChannel(samples, 0, 0);
    const sourceNode = audioContext.createBufferSource();
    sourceNode.buffer = buffer;
    const gainNode = typeof audioContext.createGain === "function" ? audioContext.createGain() : null;
    const baseGain = gain;
    if (gainNode) {
      gainNode.gain.value = muted ? 0 : (optimisticallyDucked ? optimisticDuckGain : baseGain);
      sourceNode.connect(gainNode);
      if (sharedOutputAnalyser) gainNode.connect(sharedOutputAnalyser);
      else gainNode.connect(audioContext.destination);
    } else {
      if (sharedOutputAnalyser) sourceNode.connect(sharedOutputAnalyser);
      else sourceNode.connect(audioContext.destination);
    }

    const durationMs = (buffer.duration || 0) * 1000;
    const startAt = Math.max(audioContext.currentTime || 0, nextStartTime || 0);
    const entry = { generation, audioClass, identity, node: sourceNode, gainNode, baseGain };
    sources.add(entry);
    playing = true;
    sourceNode.onended = () => {
      sources.delete(entry);
      if (generation === activeGeneration && sources.size === 0) {
        playing = false;
        emit("playback.ended", { generation, audioClass });
      }
    };
    sourceNode.start(startAt);
    nextStartTime = startAt + (buffer.duration || 0);
    emit("playback.started", { generation, audioClass, identity, durationMs });
    return true;
  }

  function handleInterruption(identity = {}) {
    setOptimisticDucked(false);
    return flush({ generation: identity.playbackGeneration ?? activeGeneration, reason: "provider-interrupted" });
  }

  return Object.freeze({
    beginGeneration,
    schedule,
    flush,
    handleInterruption,
    setMuted,
    setOptimisticDucked,
    isPlaying: () => playing,
    getActiveGeneration: () => activeGeneration,
    getQueuedSourceCount: () => sources.size,
    getOutputAnalyser: () => sharedOutputAnalyser,
  });
}
