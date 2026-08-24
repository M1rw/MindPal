import { describe, expect, it } from "vitest";
import { runVoiceV3Soak } from "./voice-v3-soak";

describe("Voice V3 ten-minute soak", () => {
  it("survives monologues, interruptions, jitter, expiry, GoAway, restart, and fallback scenarios", () => {
    const result = runVoiceV3Soak({ durationMs: 10 * 60 * 1_000, tickMs: 20, seed: 13 });

    expect(result.durationMs).toBe(600_000);
    expect(result.maxCueBufferSize).toBeLessThanOrEqual(3);
    expect(result.maxQueueDepthMs).toBeLessThanOrEqual(1_600);
    expect(result.staleAudioPlayback).toBe(0);
    expect(result.duplicateCaptions).toBe(0);
    expect(result.repeatedGreetings).toBe(0);
    expect(result.mismatchedPersonaCues).toBe(0);
    expect(result.tokenRefreshes).toBeGreaterThan(0);
    expect(result.goAwayRecoveries).toBeGreaterThan(0);
    expect(result.ttsTimeouts).toBeGreaterThan(0);
    expect(result.missingPersonaMappings).toBeGreaterThan(0);
    expect(result.fallbackActivations).toBeGreaterThan(0);
    expect(result.backendRestarts).toBeGreaterThan(0);
    expect(result.passed).toBe(true);
  });
});
