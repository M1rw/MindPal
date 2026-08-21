import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it, vi, type MockedFunction } from "vitest";
import { createEventEnvelope, LayerLinkMessageBus } from "../core/message-bus";
import type { GenerationIdentity } from "../core/layer-link";
import { RealTokenProvider } from "./real-token-provider";
import { StaticAssetCueProvider } from "./static-asset-cue-provider";
import { TelemetrySink } from "./telemetry-sink";
import { useVoiceV3, type UseVoiceV3Result } from "./use-voice-v3";

const IDENTITY: GenerationIdentity = {
  sessionGeneration: "session-1",
  turnId: "turn-1",
  providerResponseId: "response-1",
  playbackGeneration: "session-1-playback-1",
};

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  vi.restoreAllMocks();
});

describe("RealTokenProvider", () => {
  it("fetches authenticated tokens and retries transient 5xx responses", async () => {
    let calls = 0;
    const fetchImpl = vi.fn() as unknown as MockedFunction<typeof fetch>;
    fetchImpl.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return response(503, { message: "temporary" });
      return response(200, tokenPayload(100_000));
    });
    const provider = new RealTokenProvider({
      fetchImpl,
      getAuthToken: async () => "firebase-id-token",
      getAppCheckToken: async () => "app-check-token",
      retryDelayMs: 0,
      nowMs: () => 1_000,
    });

    const token = await provider.getToken();
    expect(token.model).toBe("gemini-3.1-flash-live-preview");
    expect(calls).toBe(2);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: expect.objectContaining({
        Authorization: "Bearer firebase-id-token",
        "X-Firebase-AppCheck": "app-check-token",
      }),
    });
  });

  it("does not retry HTTP 429 and caches an unexpired token", async () => {
    let now = 1_000;
    const fetchImpl = vi.fn() as unknown as MockedFunction<typeof fetch>;
    fetchImpl.mockImplementation(async () => response(200, tokenPayload(100_000)));
    const provider = new RealTokenProvider({
      fetchImpl,
      retryDelayMs: 0,
      nowMs: () => now,
    });
    await provider.getToken();
    now += 1_000;
    await provider.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const rateLimited = new RealTokenProvider({
      fetchImpl: vi.fn(async () => response(429, { detail: "slow down" })) as unknown as typeof fetch,
      maxAttempts: 4,
      retryDelayMs: 0,
    });
    await expect(rateLimited.getToken()).rejects.toMatchObject({ status: 429 });
    expect(rateLimited.lastToken).toBeNull();
  });
});

describe("StaticAssetCueProvider", () => {
  it("decodes each cue once and returns cached mono 24 kHz PCM16 data", async () => {
    const decoded = {
      numberOfChannels: 1,
      sampleRate: 24_000,
      duration: 2 / 24_000,
      getChannelData: () => new Float32Array([-1, 0.5]),
    } as unknown as AudioBuffer;
    const decodeAudioData = vi.fn(async () => decoded);
    const fetchImpl = vi.fn(async () => response(200, undefined, new ArrayBuffer(4)));
    const provider = new StaticAssetCueProvider({
      audioContextFactory: () => ({ decodeAudioData }) as unknown as AudioContext,
      fetchImpl,
      cueNames: ["mhm"],
    });

    await provider.initialize();
    const first = provider.createCue(IDENTITY, "cue-1");
    const second = provider.createCue(IDENTITY, "cue-2");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(decodeAudioData).toHaveBeenCalledTimes(1);
    expect(first.audioLane).toBe("backchannel");
    expect(first.sampleRate).toBe(24_000);
    expect(Array.from(new Int16Array(first.data))).toEqual([-32_768, 16_384]);
    expect(second.data).not.toBe(first.data);
  });

  it("falls back to SyntheticCueProvider when an asset cannot be fetched", async () => {
    const provider = new StaticAssetCueProvider({
      audioContextFactory: () => ({ decodeAudioData: vi.fn() }) as unknown as AudioContext,
      fetchImpl: vi.fn(async () => response(404, undefined)) as unknown as typeof fetch,
    });
    await provider.initialize();
    expect(provider.hasLoadedAssets()).toBe(false);
    const cue = provider.createCue(IDENTITY, "fallback-cue");
    expect(cue.audioLane).toBe("backchannel");
    expect(cue.data.byteLength).toBeGreaterThan(0);
  });
});

describe("useVoiceV3", () => {
  it("creates and disposes the app through React lifecycle and exposes mute controls", async () => {
    let hookResult!: UseVoiceV3Result;
    function Harness() {
      hookResult = useVoiceV3({ providerMode: "mock" });
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(<Harness />);
      await tick();
    });
    expect(hookResult).toBeDefined();
    await act(async () => {
      hookResult.mute();
      await tick();
    });
    expect(hookResult.isMuted).toBe(true);
    await act(async () => {
      hookResult.unmute();
      await tick();
    });
    expect(hookResult.isMuted).toBe(false);
    root.unmount();
    await tick();
  });
});

describe("TelemetrySink", () => {
  it("batches approved counters and never serializes audio or transcript content", async () => {
    const bus = new LayerLinkMessageBus({ nowMono: () => 1_000 });
    const fetchImpl = vi.fn() as unknown as MockedFunction<typeof fetch>;
    fetchImpl.mockImplementation(async () => response(204, undefined));
    const sink = new TelemetrySink({
      bus,
      fetchImpl,
      getAuthToken: async () => "auth",
      getAppCheckToken: async () => "check",
      flushIntervalMs: 60_000,
    });
    bus.publish(envelope("PROVIDER_OUTPUT_TRANSCRIPT", {
      type: "PROVIDER_OUTPUT_TRANSCRIPT",
      text: "PRIVATE ASSISTANT TRANSCRIPT",
      audio: "PRIVATE AUDIO",
    }));
    bus.publish(envelope("PROVIDER_AUDIO", {
      dataBase64: "RAW_PCM_BASE64",
      transcript: "PRIVATE USER SPEECH",
    }));

    await sink.flush("test");
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual(expect.objectContaining({
      model: "gemini-3.1-flash-live-preview",
      audio_parts: 1,
      output_transcription_events: 1,
      end_reason: "test",
    }));
    expect(JSON.stringify(body)).not.toContain("PRIVATE");
    expect(JSON.stringify(body)).not.toContain("RAW_PCM");
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      keepalive: true,
      headers: expect.objectContaining({
        Authorization: "Bearer auth",
        "X-Firebase-AppCheck": "check",
      }),
    });
    await sink.close();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const closeBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(closeBody.end_reason).toBe("session_closed");
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ keepalive: true });
  });
});

function tokenPayload(ttlMs: number): Record<string, unknown> {
  return {
    token: "ephemeral-token",
    model: "gemini-3.1-flash-live-preview",
    websocket_url: "wss://example.test/live",
    expires_at: Date.now() + ttlMs,
    new_session_expires_at: Date.now() + ttlMs,
  };
}

function response(status: number, body: unknown, bytes?: ArrayBuffer): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    arrayBuffer: async () => bytes ?? new ArrayBuffer(0),
  } as Response;
}

function envelope(messageType: string, payload: unknown) {
  return createEventEnvelope({
    messageId: `${messageType}-test`,
    messageType,
    sourceLayer: messageType === "PROVIDER_AUDIO" ? "provider-adapter" : "provider-adapter",
    topic: "voice.provider",
    priority: "telemetry",
    timestampMono: 1_000,
    ttlMs: 10_000,
    identity: IDENTITY,
    correlationId: "test",
    payload,
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
