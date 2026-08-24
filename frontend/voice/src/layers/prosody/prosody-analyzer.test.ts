import { describe, expect, it, vi } from "vitest";
import type { GenerationIdentity } from "../../core/layer-link";
import { createEventEnvelope, LayerLinkMessageBus } from "../../core/message-bus";
import { BackchannelConductor, type BackchannelCueRequestPayload } from "../backchannel/conductor";
import type { VoiceEvent } from "../adapter/event-types";
import { ProsodyAnalyzer } from "./prosody-analyzer";
import { TelemetrySink } from "../../integration/telemetry-sink";
import type { ProsodyState } from "./prosody-state";

const IDENTITY: GenerationIdentity = {
  sessionGeneration: "session-1",
  turnId: "turn-1",
  providerResponseId: "response-1",
  playbackGeneration: "playback-1",
};

function publishCapture(bus: LayerLinkMessageBus, now: number, rms: number, muted = false): void {
  bus.publish(createEventEnvelope({
    messageId: `capture-${now}`,
    messageType: "capture.frame",
    sourceLayer: "capture",
    topic: "voice.capture",
    priority: "normal",
    timestampMono: now,
    ttlMs: 10_000,
    identity: IDENTITY,
    correlationId: "prosody-test",
    payload: {
      frameId: `frame-${now}`,
      sequence: Math.floor(now / 20),
      sampleRate: 16_000,
      channels: 1,
      format: "pcm_s16le",
      data: new ArrayBuffer(640),
      capturedAtMono: now,
      durationMs: 20,
      muted,
      rms,
    },
  }));
}

function publishAdapter(bus: LayerLinkMessageBus, now: number, event: VoiceEvent): void {
  bus.publish(createEventEnvelope({
    messageId: `adapter-${now}`,
    messageType: "adapter.event",
    sourceLayer: "provider-adapter",
    topic: "voice.provider",
    priority: "high",
    timestampMono: now,
    ttlMs: 10_000,
    identity: IDENTITY,
    correlationId: "prosody-test",
    payload: event,
  }));
}

function publishProsody(bus: LayerLinkMessageBus, now: number, state: ProsodyState): void {
  bus.publish(createEventEnvelope({
    messageId: `prosody-${now}`,
    messageType: "prosody.state.updated",
    sourceLayer: "prosody",
    topic: "voice.prosody",
    priority: "telemetry",
    timestampMono: now,
    ttlMs: 10_000,
    identity: IDENTITY,
    correlationId: "prosody-test",
    payload: state,
  }));
}

describe("ProsodyAnalyzer", () => {
  it("infers a conservative high-energy fast state without inventing provider emotion fields", () => {
    let now = 0;
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const states: ProsodyState[] = [];
    const notes: unknown[] = [];
    bus.subscribe<ProsodyState>((envelope) => states.push(envelope.payload), { topic: "voice.prosody", messageType: "prosody.state.updated" });
    bus.subscribe((envelope) => notes.push(envelope.payload), { topic: "voice.transport", messageType: "prosody.context.note" });
    const analyzer = new ProsodyAnalyzer({ bus, nowMono: () => now });

    publishAdapter(bus, now, {
      type: "PROVIDER_INPUT_TRANSCRIPT",
      identity: IDENTITY,
      payload: { text: Array.from({ length: 100 }, () => "word").join(" "), isFinal: false, cumulative: true },
    });
    for (now = 0; now <= 3_200; now += 20) publishCapture(bus, now, 0.2);

    const finalState = analyzer.state;
    expect(["urgent", "frustrated"]).toContain(finalState.emotionalGuess);
    expect(finalState.confidence).toBeGreaterThanOrEqual(0.65);
    expect(notes.some((entry) => typeof entry === "object" && entry !== null && "note" in entry)).toBe(true);
    expect(states.every((state) => !Object.prototype.hasOwnProperty.call(state, "data"))).toBe(true);
    analyzer.dispose();
  });

  it("does not classify anger from loudness alone", () => {
    let now = 0;
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const analyzer = new ProsodyAnalyzer({ bus, nowMono: () => now });
    for (now = 0; now <= 3_000; now += 20) publishCapture(bus, now, 0.4);
    expect(analyzer.state.emotionalGuess).not.toBe("angry");
    analyzer.dispose();
  });

  it("requires sufficient confidence before labeling quiet hesitant speech as sad", () => {
    let now = 0;
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const analyzer = new ProsodyAnalyzer({ bus, nowMono: () => now, confidenceThreshold: 0.5 });
    publishCapture(bus, now, 0.1);
    for (now = 20; now <= 2_200; now += 20) publishCapture(bus, now, 0);
    expect(["sad", "neutral"]).toContain(analyzer.state.emotionalGuess);
    expect(analyzer.state.confidence).toBeGreaterThanOrEqual(0.5);
    analyzer.dispose();
  });

  it("uses hysteresis so rapid signal flapping does not rapidly change the emotional state", () => {
    let now = 0;
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const changes: ProsodyState[] = [];
    bus.subscribe<ProsodyState>((envelope) => changes.push(envelope.payload), { topic: "voice.prosody", messageType: "prosody.state.updated" });
    const analyzer = new ProsodyAnalyzer({ bus, nowMono: () => now });
    for (now = 0; now <= 700; now += 20) publishCapture(bus, now, now % 40 === 0 ? 0.3 : 0);
    expect(changes.filter((state) => state.lastChangedAtMono > 0)).toHaveLength(0);
    analyzer.dispose();
  });

  it("does not send raw audio, PCM, transcripts, or context-note text to telemetry", async () => {
    let requestBody: Record<string, unknown> | null = null;
    const bus = new LayerLinkMessageBus({ nowMono: () => 0 });
    const sink = new TelemetrySink({
      bus,
      fetchImpl: vi.fn(async (_url, init) => {
        requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return { ok: true, status: 204 } as Response;
      }),
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });
    publishCapture(bus, 0, 0.2);
    bus.publish(createEventEnvelope({
      messageId: "raw-transcript",
      messageType: "prosody.context.note",
      sourceLayer: "prosody",
      topic: "voice.transport",
      priority: "high",
      timestampMono: 0,
      ttlMs: 10_000,
      identity: IDENTITY,
      correlationId: "privacy-test",
      payload: { note: "private transcript content", data: new ArrayBuffer(8) },
    }));
    await sink.flush("session_closed", true);
    expect(requestBody).not.toBeNull();
    expect(JSON.stringify(requestBody)).not.toContain("private transcript content");
    expect(JSON.stringify(requestBody)).not.toContain("data");
    await sink.close();
  });

  it("emits context notes only on high-confidence state change or final turn", () => {
    let now = 0;
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const notes: Array<{ readonly reason?: string }> = [];
    bus.subscribe<{ readonly reason?: string }>((envelope) => notes.push(envelope.payload), { topic: "voice.transport", messageType: "prosody.context.note" });
    const analyzer = new ProsodyAnalyzer({ bus, nowMono: () => now });
    publishAdapter(bus, now, { type: "PROVIDER_INPUT_TRANSCRIPT", identity: IDENTITY, payload: { text: "hello", isFinal: false, cumulative: true } });
    expect(notes).toHaveLength(0);
    publishAdapter(bus, now + 1, { type: "PROVIDER_INPUT_TRANSCRIPT", identity: IDENTITY, payload: { text: "hello", isFinal: true, cumulative: true } });
    expect(notes).toHaveLength(0);
    publishAdapter(bus, now + 2, { type: "PROVIDER_TURN_COMPLETE", identity: IDENTITY, payload: {} });
    expect(notes).toHaveLength(0);
    analyzer.dispose();
  });
});

describe("Prosody-aware backchannel adaptation", () => {
  it("passes a calm TTS style and non-cheerful cue for frustrated prosody", async () => {
    let now = 0;
    const timers: Array<{ due: number; callback: () => void; active: boolean }> = [];
    const provider = {
      createCue: () => { throw new Error("predictive path expected"); },
      snapshot: { state: "ready" as const },
      generate: vi.fn(async () => ({
        chunk: {
          chunkId: "cue",
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
      })),
    };
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const requests: BackchannelCueRequestPayload[] = [];
    bus.subscribe<BackchannelCueRequestPayload>((envelope) => requests.push(envelope.payload), { topic: "voice.playback", messageType: "BACKCHANNEL_CUE_REQUESTED" });
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
    publishProsody(bus, now, { energyLevel: "high", speechRate: "fast", pausePattern: "natural", emotionalGuess: "frustrated", confidence: 0.8, lastChangedAtMono: now });
    expect({ state: conductor.currentProsody.emotionalGuess, bus: bus.snapshot() }).toMatchObject({ state: "frustrated", bus: { deliveredEvents: 1, rejectedEvents: 0, expiredEvents: 0, handlerFailures: 0 } });
    publishCapture(bus, now, 0.1);
    for (now = 20; now <= 2_520; now += 20) publishCapture(bus, now, 0.1);
    now = 2_650;
    publishCapture(bus, now, 0);
    now = 2_800;
    runTimers(timers, now);
    await Promise.resolve();
    await Promise.resolve();
    now = 3_250;
    runTimers(timers, now);
    expect(provider.generate).toHaveBeenCalledWith(expect.objectContaining({ cueText: "mhm", emotion: "concerned" }));
    expect(requests).toHaveLength(1);
    conductor.dispose();
  });

  function runTimers(timers: Array<{ due: number; callback: () => void; active: boolean }>, now: number): void {
    for (const timer of timers.filter((candidate) => candidate.active && candidate.due <= now)) {
      timer.active = false;
      timer.callback();
    }
  }
});
