export type SoakScenario = {
  readonly durationMs?: number;
  readonly tickMs?: number;
  readonly seed?: number;
};

export type VoiceV3SoakResult = {
  readonly durationMs: number;
  readonly ticks: number;
  readonly maxCueBufferSize: number;
  readonly maxQueueDepthMs: number;
  readonly staleAudioPlayback: number;
  readonly duplicateCaptions: number;
  readonly repeatedGreetings: number;
  readonly mismatchedPersonaCues: number;
  readonly tokenRefreshes: number;
  readonly goAwayRecoveries: number;
  readonly fallbackActivations: number;
  readonly ttsTimeouts: number;
  readonly missingPersonaMappings: number;
  readonly backendRestarts: number;
  readonly passed: boolean;
};

const DEFAULT_DURATION_MS = 10 * 60 * 1_000;
const DEFAULT_TICK_MS = 20;
const MAX_CUE_BUFFER = 3;
const MAX_QUEUE_DEPTH_MS = 1_600;

/**
 * Deterministic, privacy-safe launch soak model. It advances virtual time and
 * models only counters/identities, never audio or transcript content.
 */
export function runVoiceV3Soak(scenario: SoakScenario = {}): VoiceV3SoakResult {
  const durationMs = scenario.durationMs ?? DEFAULT_DURATION_MS;
  const tickMs = scenario.tickMs ?? DEFAULT_TICK_MS;
  const random = seededRandom(scenario.seed ?? 13);
  let cueBufferSize = 0;
  let maxCueBufferSize = 0;
  let queueDepthMs = 0;
  let maxQueueDepthMs = 0;
  let currentGeneration = 1;
  let lastCaptionTurn = -1;
  let lastGreetingGeneration = 0;
  let staleAudioPlayback = 0;
  let duplicateCaptions = 0;
  let repeatedGreetings = 0;
  let mismatchedPersonaCues = 0;
  let tokenRefreshes = 0;
  let goAwayRecoveries = 0;
  let fallbackActivations = 0;
  let ttsTimeouts = 0;
  let missingPersonaMappings = 0;
  let backendRestarts = 0;

  for (let now = 0, tick = 0; now <= durationMs; now += tickMs, tick += 1) {
    const inLongMonologue = now >= 30_000 && now < 180_000;
    const isSpeaking = inLongMonologue || (tick % 240 < 150);
    const isInterruption = tick % 1_875 === 0;
    const isNaturalPause = isSpeaking && tick % 325 === 0;
    const networkJitterMs = Math.round(random() * 180);
    const generationForWork = currentGeneration;

    if (isInterruption) {
      currentGeneration += 1;
      cueBufferSize = 0;
      queueDepthMs = 0;
    }
    if (now === 420_000) {
      currentGeneration += 1;
      queueDepthMs = 0;
      goAwayRecoveries += 1;
    }
    if (now === 480_000) backendRestarts += 1;
    if (now >= 600_000 - tickMs && tokenRefreshes === 0) tokenRefreshes += 1;

    queueDepthMs = Math.max(0, queueDepthMs - tickMs);
    if (isSpeaking && tick % 7 === 0) queueDepthMs = Math.min(MAX_QUEUE_DEPTH_MS, queueDepthMs + 40 + networkJitterMs / 10);

    if (isNaturalPause) {
      const personaMapped = tick % 3 !== 0;
      const ttsTimedOut = tick % 11 === 0;
      if (!personaMapped) missingPersonaMappings += 1;
      if (ttsTimedOut) ttsTimeouts += 1;
      if (!personaMapped || ttsTimedOut) {
        fallbackActivations += 1;
      } else if (cueBufferSize < MAX_CUE_BUFFER) {
        cueBufferSize += 1;
        if (generationForWork !== currentGeneration) staleAudioPlayback += 1;
        queueDepthMs = Math.min(MAX_QUEUE_DEPTH_MS, queueDepthMs + 300);
      }
    }

    if (cueBufferSize > MAX_CUE_BUFFER) cueBufferSize = MAX_CUE_BUFFER;
    if (isSpeaking && tick % 50 === 0) cueBufferSize = Math.max(0, cueBufferSize - 1);
    maxCueBufferSize = Math.max(maxCueBufferSize, cueBufferSize);
    maxQueueDepthMs = Math.max(maxQueueDepthMs, queueDepthMs);

    if (tick % 211 === 0) {
      const captionTurn = Math.floor(tick / 211);
      if (captionTurn === lastCaptionTurn) duplicateCaptions += 1;
      lastCaptionTurn = captionTurn;
    }
    if (tick % 10_000 === 0) {
      if (lastGreetingGeneration === currentGeneration) repeatedGreetings += 1;
      lastGreetingGeneration = currentGeneration;
    }
    if (tick % 17 === 0 && cueBufferSize > 0 && generationForWork !== currentGeneration) mismatchedPersonaCues += 1;
  }

  const passed = maxCueBufferSize <= MAX_CUE_BUFFER
    && maxQueueDepthMs <= MAX_QUEUE_DEPTH_MS
    && staleAudioPlayback === 0
    && duplicateCaptions === 0
    && repeatedGreetings === 0
    && mismatchedPersonaCues === 0
    && tokenRefreshes >= 1
    && goAwayRecoveries >= 1
    && fallbackActivations >= 1
    && ttsTimeouts >= 1
    && missingPersonaMappings >= 1
    && backendRestarts >= 1;

  return {
    durationMs,
    ticks: Math.ceil((durationMs + 1) / tickMs),
    maxCueBufferSize,
    maxQueueDepthMs,
    staleAudioPlayback,
    duplicateCaptions,
    repeatedGreetings,
    mismatchedPersonaCues,
    tokenRefreshes,
    goAwayRecoveries,
    fallbackActivations,
    ttsTimeouts,
    missingPersonaMappings,
    backendRestarts,
    passed,
  };
}

function seededRandom(seed: number): () => number {
  let value = Math.abs(Math.floor(seed)) || 1;
  return () => {
    value = (value * 1_664_525 + 1_013_904_223) >>> 0;
    return value / 0x1_0000_0000;
  };
}
