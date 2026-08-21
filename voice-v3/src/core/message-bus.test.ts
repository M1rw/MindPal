import {
  createEventEnvelope,
  LayerLinkMessageBus,
  validateEnvelope,
} from "./message-bus";
import type { GenerationIdentity } from "./layer-link";

const identity: GenerationIdentity = {
  sessionGeneration: "session-1",
  turnId: "turn-1",
  providerResponseId: "response-1",
  playbackGeneration: "playback-1",
};

describe("LayerLinkMessageBus", () => {
  it("delivers a valid event to matching subscribers", () => {
    const bus = new LayerLinkMessageBus({ nowMono: () => 100 });
    const received: string[] = [];
    bus.subscribe<{ value: string }>(
      (envelope) => received.push(envelope.payload.value),
      { topic: "voice.control" },
    );

    const result = bus.publish(
      createEventEnvelope({
        messageId: "message-1",
        messageType: "voice.state.changed",
        sourceLayer: "orchestrator",
        topic: "voice.control",
        priority: "high",
        timestampMono: 90,
        timestampWall: "2026-08-21T00:00:00.000Z",
        ttlMs: 100,
        identity,
        correlationId: "correlation-1",
        payload: { value: "listening" },
      }),
    );

    expect(result).toEqual({ accepted: true, delivered: 1 });
    expect(received).toEqual(["listening"]);
    expect(bus.snapshot()).toMatchObject({ deliveredEvents: 1, rejectedEvents: 0 });
  });

  it("does not deliver a message to a different topic", () => {
    const bus = new LayerLinkMessageBus({ nowMono: () => 100 });
    const received: string[] = [];
    bus.subscribe((envelope) => received.push(envelope.messageType), {
      topic: "voice.audio",
    });

    const result = bus.publish(
      createEventEnvelope({
        messageId: "message-2",
        messageType: "voice.caption.updated",
        sourceLayer: "caption",
        topic: "voice.caption",
        priority: "normal",
        timestampMono: 90,
        ttlMs: 100,
        identity,
        correlationId: "correlation-2",
        payload: { text: "hello" },
      }),
    );

    expect(result).toEqual({ accepted: true, delivered: 0 });
    expect(received).toEqual([]);
  });

  it("rejects malformed envelopes before delivery", () => {
    const diagnostics: string[] = [];
    const bus = new LayerLinkMessageBus({
      nowMono: () => 100,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.reason),
    });

    const result = bus.publish({
      messageId: "bad-message",
      messageClass: "event",
    } as never);

    expect(result).toEqual({ accepted: false, reason: "invalid" });
    expect(diagnostics[0]).toContain("schemaVersion");
  });

  it("rejects expired envelopes and reports expiry", () => {
    const bus = new LayerLinkMessageBus({ nowMono: () => 200 });
    const expired = createEventEnvelope({
      messageId: "expired-message",
      messageType: "voice.audio.chunk",
      sourceLayer: "playback",
      priority: "high",
      timestampMono: 100,
      ttlMs: 100,
      identity,
      correlationId: "correlation-3",
      payload: { bytes: 20 },
    });

    expect(validateEnvelope(expired, 200)).toEqual({
      valid: false,
      reason: "expired",
      detail: "message TTL has expired",
    });
    expect(bus.publish(expired)).toEqual({ accepted: false, reason: "expired" });
    expect(bus.snapshot()).toMatchObject({ expiredEvents: 1, rejectedEvents: 1 });
  });

  it("isolates subscriber failures and continues delivery", () => {
    const diagnostics: string[] = [];
    const bus = new LayerLinkMessageBus({
      nowMono: () => 100,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.type),
    });
    const received: string[] = [];
    bus.subscribe(() => {
      throw new Error("subscriber failure");
    });
    bus.subscribe(() => received.push("healthy"));

    const result = bus.publish(
      createEventEnvelope({
        messageId: "message-4",
        messageType: "voice.test",
        sourceLayer: "telemetry",
        priority: "telemetry",
        timestampMono: 90,
        ttlMs: 100,
        identity,
        correlationId: "correlation-4",
        payload: null,
      }),
    );

    expect(result).toEqual({ accepted: true, delivered: 1 });
    expect(received).toEqual(["healthy"]);
    expect(diagnostics).toContain("handler-failed");
  });
});
