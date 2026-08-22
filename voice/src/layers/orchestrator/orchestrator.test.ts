import { describe, expect, it } from "vitest";
import type { GenerationIdentity } from "../../core/layer-link";
import { createEventEnvelope, LayerLinkMessageBus } from "../../core/message-bus";
import type { VoiceEvent } from "../adapter/event-types";
import { ORCHESTRATOR_STATES } from "./state-machine";
import { VoiceOrchestrator } from "./orchestrator";

const sessionIdentity: GenerationIdentity = {
  sessionGeneration: "session-1",
  turnId: "turn-1",
  providerResponseId: "response-1",
  playbackGeneration: null,
};

function publishAdapterEvent(bus: LayerLinkMessageBus, nowMono: number, event: VoiceEvent): void {
  bus.publish(
    createEventEnvelope({
      messageId: `adapter-${nowMono}-${event.type}`,
      messageType: "adapter.event",
      sourceLayer: "provider-adapter",
      topic: "voice.provider",
      priority: "high",
      timestampMono: nowMono,
      ttlMs: 10_000,
      identity: event.identity,
      correlationId: "orchestrator-test",
      payload: event,
    }),
  );
}

function inputEvent(turnId: string, isFinal = false): VoiceEvent {
  return {
    type: "PROVIDER_INPUT_TRANSCRIPT",
    identity: { ...sessionIdentity, turnId, providerResponseId: null },
    payload: { text: "hello", isFinal, cumulative: true },
  };
}

function audioEvent(identity: GenerationIdentity): VoiceEvent {
  return {
    type: "PROVIDER_AUDIO",
    identity,
    payload: { dataBase64: "AAAA", mimeType: "audio/pcm;rate=24000", sampleRate: 24_000 },
  };
}

function completeEvent(identity: GenerationIdentity): VoiceEvent {
  return { type: "PROVIDER_TURN_COMPLETE", identity, payload: {} };
}

describe("Voice V3 orchestrator state machine", () => {
  it("contains the complete requested state vocabulary", () => {
    expect(ORCHESTRATOR_STATES).toEqual([
      "IDLE",
      "CREDENTIAL_ACQUIRING",
      "PROVISIONING",
      "CONNECTING",
      "PROVIDER_READY",
      "GREETING_REQUESTED",
      "LISTENING",
      "USER_SPEAKING",
      "USER_MONOLOGUE_ACTIVE",
      "BACKCHANNEL_ELIGIBLE",
      "ASSISTANT_SPEAKING",
      "BARGE_IN_PENDING",
      "INTERRUPTED",
      "THINKING",
      "OPERATION_PENDING",
      "RECOVERING",
      "RESUMING",
      "FALLBACK_ACTIVATING",
      "CLOSING",
      "CLOSED",
      "FAILED",
    ]);
  });
});

describe("VoiceOrchestrator chaos fencing", () => {
  it("allows a second response turn with audio after first turn completes", () => {
    let now = 0;
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const playbackEvents: unknown[] = [];
    bus.subscribe((envelope) => playbackEvents.push(envelope.payload), {
      topic: "voice.playback",
      messageType: "ORCHESTRATOR_AUDIO_EVENT",
    });
    const orchestrator = new VoiceOrchestrator({ bus, nowMono: () => now });

    // Turn 1
    publishAdapterEvent(bus, now, audioEvent({ ...sessionIdentity, turnId: "turn-1", providerResponseId: "resp-1" }));
    expect(playbackEvents).toHaveLength(1);

    now = 1;
    publishAdapterEvent(bus, now, completeEvent({ ...sessionIdentity, turnId: "turn-1", providerResponseId: "resp-1" }));
    expect(orchestrator.snapshot.providerResponseClosed).toBe(true);

    // Turn 2: New turn arrives
    now = 2;
    publishAdapterEvent(bus, now, audioEvent({ ...sessionIdentity, turnId: "turn-2", providerResponseId: "resp-2" }));
    expect(playbackEvents).toHaveLength(2);
    expect(orchestrator.snapshot.providerResponseClosed).toBe(false);
  });

  it("drops late PCM after turn completion and never routes it to playback", () => {
    let now = 0;
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const playbackEvents: unknown[] = [];
    const staleEvents: unknown[] = [];
    bus.subscribe((envelope) => playbackEvents.push(envelope.payload), {
      topic: "voice.playback",
      messageType: "ORCHESTRATOR_AUDIO_EVENT",
    });
    bus.subscribe((envelope) => staleEvents.push(envelope.payload), {
      topic: "voice.orchestrator",
      messageType: "ORCHESTRATOR_STALE_REJECTED",
    });
    const orchestrator = new VoiceOrchestrator({ bus, nowMono: () => now });

    publishAdapterEvent(bus, now, inputEvent("turn-1"));
    now = 1;
    publishAdapterEvent(bus, now, audioEvent(sessionIdentity));
    now = 2;
    publishAdapterEvent(bus, now, completeEvent({ ...sessionIdentity, playbackGeneration: orchestrator.identity.playbackGeneration }));
    now = 3;
    publishAdapterEvent(bus, now, audioEvent({ ...sessionIdentity, playbackGeneration: orchestrator.identity.playbackGeneration }));

    expect(playbackEvents).toHaveLength(1);
    expect(staleEvents).toHaveLength(1);
    expect(orchestrator.snapshot.providerResponseClosed).toBe(true);
    expect(orchestrator.snapshot.staleEventsRejected).toBe(1);
  });

  it("rejects a tool result from the old operation after a new turn begins", () => {
    let now = 0;
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const operationRequests: Array<{ readonly operation?: { readonly operationId?: string } }> = [];
    const staleEvents: unknown[] = [];
    bus.subscribe((envelope) => operationRequests.push(envelope.payload as typeof operationRequests[number]), {
      topic: "voice.operation",
      messageType: "ORCHESTRATOR_OPERATION_REQUESTED",
    });
    bus.subscribe((envelope) => staleEvents.push(envelope.payload), {
      topic: "voice.orchestrator",
      messageType: "ORCHESTRATOR_STALE_REJECTED",
    });
    const orchestrator = new VoiceOrchestrator({ bus, nowMono: () => now });
    const toolCall: VoiceEvent = {
      type: "PROVIDER_TOOL_CALL",
      identity: sessionIdentity,
      payload: { call: { name: "lookup" } },
    };
    publishAdapterEvent(bus, now, toolCall);
    const oldOperationId = operationRequests[0]?.operation?.operationId;
    expect(oldOperationId).toBeTruthy();

    now = 1;
    publishAdapterEvent(bus, now, inputEvent("turn-2"));
    now = 2;
    bus.publish(
      createEventEnvelope({
        messageId: "late-operation-result",
        messageType: "operation.result",
        sourceLayer: "operation",
        topic: "voice.operation",
        priority: "high",
        timestampMono: now,
        ttlMs: 10_000,
        identity: { ...sessionIdentity, turnId: "turn-1" },
        operation: { ...sessionIdentity, operationId: oldOperationId ?? "missing" },
        correlationId: "old-operation",
        payload: { operationId: oldOperationId, value: "stale" },
      }),
    );

    expect(staleEvents).toHaveLength(1);
    expect(orchestrator.snapshot.operationId).toBeNull();
  });

  it("does not allow a late cumulative greeting transcript to reopen a completed greeting", () => {
    let now = 0;
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const transcriptEvents: unknown[] = [];
    const staleEvents: unknown[] = [];
    bus.subscribe((envelope) => transcriptEvents.push(envelope.payload), {
      topic: "voice.transcript",
      messageType: "ORCHESTRATOR_TRANSCRIPT_EVENT",
    });
    bus.subscribe((envelope) => staleEvents.push(envelope.payload), {
      topic: "voice.orchestrator",
      messageType: "ORCHESTRATOR_STALE_REJECTED",
    });
    const orchestrator = new VoiceOrchestrator({ bus, nowMono: () => now });
    expect(orchestrator.requestGreeting()).toBe(true);
    expect(orchestrator.requestGreeting()).toBe(false);

    const greetingIdentity: GenerationIdentity = {
      sessionGeneration: "session-1",
      turnId: null,
      providerResponseId: "greeting-response",
      playbackGeneration: null,
    };
    now = 1;
    publishAdapterEvent(bus, now, completeEvent(greetingIdentity));
    now = 2;
    publishAdapterEvent(bus, now, {
      type: "PROVIDER_OUTPUT_TRANSCRIPT",
      identity: greetingIdentity,
      payload: { text: "Welcome again", isFinal: true, cumulative: true },
    });

    expect(transcriptEvents).toHaveLength(1);
    expect(staleEvents).toHaveLength(1);
    expect(orchestrator.greetingSent).toBe(true);
    expect(orchestrator.state).toBe("LISTENING");
  });

  it("increments playback generation and flushes the old generation on interruption", () => {
    let now = 0;
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const flushes: unknown[] = [];
    bus.subscribe((envelope) => flushes.push(envelope.payload), {
      topic: "voice.playback",
      messageType: "ORCHESTRATOR_FLUSH_PLAYBACK",
    });
    const orchestrator = new VoiceOrchestrator({ bus, nowMono: () => now });
    publishAdapterEvent(bus, now, inputEvent("turn-1"));
    now = 1;
    publishAdapterEvent(bus, now, audioEvent(sessionIdentity));
    const oldGeneration = orchestrator.identity.playbackGeneration;
    now = 2;
    publishAdapterEvent(bus, now, {
      type: "PROVIDER_INTERRUPTED",
      identity: { ...sessionIdentity, playbackGeneration: oldGeneration },
      payload: {},
    });

    expect(flushes).toHaveLength(1);
    expect((flushes[0] as { oldPlaybackGeneration?: string }).oldPlaybackGeneration).toBe(oldGeneration);
    expect(orchestrator.identity.playbackGeneration).not.toBe(oldGeneration);
    expect(orchestrator.state).toBe("INTERRUPTED");
  });
});
