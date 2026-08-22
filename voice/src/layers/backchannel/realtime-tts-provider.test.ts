import { describe, expect, it, vi, type MockedFunction } from "vitest";
import { createEventEnvelope, LayerLinkMessageBus } from "../../core/message-bus";
import type { GenerationIdentity } from "../../core/layer-link";
import { RealtimeTTSProvider } from "./realtime-tts-provider";
import { BackchannelConductor, type BackchannelCueRequestPayload } from "./conductor";

const IDENTITY: GenerationIdentity = {
  sessionGeneration: "session-1",
  turnId: "turn-1",
  providerResponseId: "response-1",
  playbackGeneration: "playback-1",
};

const PCM_BASE64 = "AAABAA==";

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Headers(),
  } as Response;
}

describe("RealtimeTTSProvider", () => {
  it("uses the authenticated network path with the exact persona request contract", async () => {
    const fetchImpl = vi.fn() as unknown as MockedFunction<typeof fetch>;
    fetchImpl.mockImplementation(async () => response(200, { audioBase64: PCM_BASE64, durationMs: 100 }));
    const provider = new RealtimeTTSProvider({
      baseUrl: "https://mindpal.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAuthToken: async () => "id-token",
      getAppCheckToken: async () => "app-check",
      nowMs: () => 100,
    });

    const generated = await provider.generate({
      cueText: "mhm",
      voicePersona: "Kore",
      emotion: "neutral",
      identity: IDENTITY,
      cueId: "cue-1",
    });

    expect(generated.source).toBe("network");
    expect(Array.from(new Uint8Array(generated.chunk.data))).toEqual([0, 0, 1, 0]);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://mindpal.test/api/voice/v3/tts");
    expect(init).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer id-token",
        "X-Firebase-AppCheck": "app-check",
      }),
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "mhm",
      persona: "Kore",
      emotion: "neutral",
      format: "pcm16",
      sampleRate: 24_000,
    });
  });

  it("caches repeated cues and avoids a second network request", async () => {
    const fetchImpl = vi.fn() as unknown as MockedFunction<typeof fetch>;
    fetchImpl.mockImplementation(async () => response(200, { audioBase64: PCM_BASE64, durationMs: 100 }));
    const provider = new RealtimeTTSProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      nowMs: () => 100,
    });
    await provider.generate({ cueText: "yeah", voicePersona: "Kore", emotion: "neutral", identity: IDENTITY, cueId: "cue-1" });
    const second = await provider.generate({ cueText: "yeah", voicePersona: "Kore", emotion: "neutral", identity: IDENTITY, cueId: "cue-2" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second.latencyMs).toBe(0);
    expect(second.chunk.chunkId).toBe("cue-2");
  });

  it("uses the preloaded local model when network latency exceeds the threshold", async () => {
    const localGenerate = vi.fn(async () => ({ audioBase64: PCM_BASE64, durationMs: 120 }));
    const neverSettles = new Promise<Response>(() => undefined);
    const provider = new RealtimeTTSProvider({
      fetchImpl: vi.fn(() => neverSettles) as unknown as typeof fetch,
      networkTimeoutMs: 5,
      localModel: {
        initialize: vi.fn(async () => undefined),
        generate: localGenerate,
      },
    });

    const generated = await provider.generate({ cueText: "aha", voicePersona: "Kore", emotion: "empathetic", identity: IDENTITY, cueId: "cue-local" });
    expect(generated.source).toBe("local");
    expect(localGenerate).toHaveBeenCalledTimes(1);
  });

  it("plays a non-verbal hum when the backend reports a missing persona mapping", async () => {
    const events: string[] = [];
    const provider = new RealtimeTTSProvider({
      fetchImpl: vi.fn(async () => response(200, { audioBase64: "", durationMs: 300, fallback: "non_verbal_hum" })) as unknown as typeof fetch,
      onEvent: (event) => events.push(event.type),
    });
    const generated = await provider.generate({ cueText: "mhm", voicePersona: "Unknown", emotion: "neutral", identity: IDENTITY, cueId: "cue-missing" });
    expect(generated.source).toBe("fallback");
    expect(events).toContain("tts.persona_mapping_missing");
    expect(events).toContain("tts.fallback.nonverbal");
  });

  it("uses the non-verbal hum for malformed backend audio", async () => {
    const events: string[] = [];
    const provider = new RealtimeTTSProvider({
      fetchImpl: vi.fn(async () => response(200, { audioBase64: "AQ", durationMs: 100 })) as unknown as typeof fetch,
      onEvent: (event) => events.push(event.type),
    });
    const generated = await provider.generate({ cueText: "aha", voicePersona: "Kore", emotion: "neutral", identity: IDENTITY, cueId: "cue-malformed" });
    expect(generated.source).toBe("fallback");
    expect(events).toContain("tts.fallback.nonverbal");
  });

  it("retries once with neutral when a backend rejects an emotional style", async () => {
    const fetchImpl = vi.fn() as unknown as MockedFunction<typeof fetch>;
    fetchImpl.mockResolvedValueOnce(response(422, { detail: "emotion unsupported" }));
    fetchImpl.mockResolvedValueOnce(response(200, { audioBase64: PCM_BASE64, durationMs: 100 }));
    const events: string[] = [];
    const provider = new RealtimeTTSProvider({ fetchImpl: fetchImpl as unknown as typeof fetch, onEvent: (event) => events.push(event.type) });
    const generated = await provider.generate({ cueText: "yeah", voicePersona: "Kore", emotion: "empathetic", identity: IDENTITY, cueId: "cue-retry" });
    expect(generated.source).toBe("network");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({ emotion: "neutral" });
    expect(events).toContain("tts.emotion_unsupported");
  });

  it("returns a non-verbal hum when both network and local generation fail", async () => {
    const provider = new RealtimeTTSProvider({
      fetchImpl: vi.fn(async () => response(503, {})) as unknown as typeof fetch,
      networkTimeoutMs: 5,
      localModel: { generate: async () => { throw new Error("wasm unavailable"); } },
    });
    const generated = await provider.generate({ cueText: "right", voicePersona: "Kore", emotion: "neutral", identity: IDENTITY, cueId: "cue-fallback" });
    expect(generated.source).toBe("fallback");
    expect(generated.chunk.audioLane).toBe("backchannel");
    expect(generated.chunk.data.byteLength).toBeGreaterThan(0);
  });
});

describe("BackchannelConductor predictive prefetch", () => {
  it("prefetches at 150 ms and approves the cached cue at 600 ms", async () => {
    let now = 0;
    const timers: Array<{ due: number; callback: () => void; active: boolean }> = [];
    const advanceTo = async (nextNow: number): Promise<void> => {
      now = nextNow;
      for (const timer of timers.filter((candidate) => candidate.active && candidate.due <= now)) {
        timer.active = false;
        timer.callback();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      }
    };
    const provider = new RealtimeTTSProvider({
      fetchImpl: vi.fn(async () => response(200, { audioBase64: PCM_BASE64, durationMs: 100 })) as unknown as typeof fetch,
      nowMs: () => now,
    });
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const requests: BackchannelCueRequestPayload[] = [];
    bus.subscribe<BackchannelCueRequestPayload>((envelope) => requests.push(envelope.payload), {
      topic: "voice.playback",
      messageType: "BACKCHANNEL_CUE_REQUESTED",
    });
    const conductor = new BackchannelConductor({
      bus,
      cueProvider: provider,
      nowMono: () => now,
      setTimer: (callback, delayMs) => {
        const timer = { due: now + delayMs, callback, active: true };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
    });

    publishFrame(bus, now, 0.1);
    for (now = 20; now <= 2_520; now += 20) publishFrame(bus, now, 0.1);
    now = 2_650;
    publishFrame(bus, now, 0);
    expect(conductor.snapshot.pendingCueBufferStatus).toBe("generating");

    await advanceTo(2_800);
    expect(conductor.snapshot.pendingCueBufferStatus).toBe("ready");
    await advanceTo(3_250);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.cueIdentity.cueSource).toBe("realtime-tts");
    expect(conductor.snapshot.pendingCueBufferStatus).toBe("empty");
    conductor.dispose();
  });

  it("discards a prefetched cue when speech resumes before the 600 ms approval boundary", async () => {
    let now = 0;
    const timers: Array<{ due: number; callback: () => void; active: boolean }> = [];
    const provider = {
      createCue: () => { throw new Error("synchronous path should not run"); },
      snapshot: { state: "ready" as const },
      generate: async () => ({
        chunk: {
          chunkId: "prefetched",
          sequence: 0,
          format: "pcm_s16le" as const,
          sampleRate: 24_000 as const,
          channels: 1 as const,
          data: new ArrayBuffer(2),
          audioLane: "backchannel" as const,
          identity: IDENTITY,
        },
        source: "network" as const,
        durationMs: 100,
        latencyMs: 1,
      }),
    };
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const requests: unknown[] = [];
    bus.subscribe((envelope) => requests.push(envelope.payload), { topic: "voice.playback", messageType: "BACKCHANNEL_CUE_REQUESTED" });
    const conductor = new BackchannelConductor({
      bus,
      cueProvider: provider,
      nowMono: () => now,
      setTimer: (callback, delayMs) => {
        const timer = { due: now + delayMs, callback, active: true };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
    });
    publishFrame(bus, now, 0.1);
    for (now = 20; now <= 2_520; now += 20) publishFrame(bus, now, 0.1);
    now = 2_650;
    publishFrame(bus, now, 0);
    now = 2_800;
    runDue(timers, now);
    await Promise.resolve();
    now = 2_850;
    publishFrame(bus, now, 0.1);
    now = 3_250;
    runDue(timers, now);
    expect(requests).toHaveLength(0);
    expect(conductor.snapshot.pendingCueBufferStatus).toBe("empty");
    conductor.dispose();
  });
});

function runDue(timers: Array<{ due: number; callback: () => void; active: boolean }>, now: number): void {
  for (const timer of timers.filter((candidate) => candidate.active && candidate.due <= now)) {
    timer.active = false;
    timer.callback();
  }
}

function publishFrame(bus: LayerLinkMessageBus, now: number, rms: number): void {
  bus.publish(createEventEnvelope({
    messageId: `frame-${now}`,
    messageType: "capture.frame",
    sourceLayer: "capture",
    topic: "voice.capture",
    priority: "normal",
    timestampMono: now,
    ttlMs: 10_000,
    identity: IDENTITY,
    correlationId: "tts-test",
    payload: {
      frameId: `frame-${now}`,
      sequence: Math.floor(now / 20),
      sampleRate: 16_000,
      channels: 1,
      format: "pcm_s16le",
      data: new ArrayBuffer(640),
      capturedAtMono: now,
      durationMs: 20,
      muted: false,
      rms,
    },
  }));
}
