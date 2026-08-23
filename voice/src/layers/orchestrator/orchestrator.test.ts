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

function publishCaptureFrame(bus: LayerLinkMessageBus, nowMono: number, rms: number, muted = false): void {
  bus.publish(
    createEventEnvelope({
      messageId: `capture-${nowMono}-${rms}`,
      messageType: "capture.frame",
      sourceLayer: "capture",
      topic: "voice.capture",
      priority: "high",
      timestampMono: nowMono,
      ttlMs: 10_000,
      identity: sessionIdentity,
      correlationId: "orchestrator-test",
      payload: {
        frameId: `frame-${nowMono}`,
        sequence: nowMono,
        sampleRate: 16_000,
        channels: 1,
        format: "pcm_s16le",
        data: new ArrayBuffer(640),
        capturedAtMono: nowMono,
        durationMs: 20,
        muted,
        rms,
      },
    }),
  );
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

  it("allows successive turns with null turn IDs and fresh response IDs without getting stuck", () => {
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

    // First response turn (e.g. greeting or first AI turn with null turnId)
    const nullTurnIdentity1: GenerationIdentity = {
      sessionGeneration: "session-1",
      turnId: null,
      providerResponseId: "resp-null-1",
      playbackGeneration: null,
    };
    publishAdapterEvent(bus, now, audioEvent(nullTurnIdentity1));
    expect(playbackEvents).toHaveLength(1);

    now = 1;
    publishAdapterEvent(bus, now, completeEvent(nullTurnIdentity1));
    expect(orchestrator.snapshot.providerResponseClosed).toBe(true);

    // User input arrives without explicit turnId
    now = 2;
    publishAdapterEvent(bus, now, {
      type: "PROVIDER_INPUT_TRANSCRIPT",
      identity: { sessionGeneration: "session-1", turnId: null, providerResponseId: null, playbackGeneration: null },
      payload: { text: "hello mindpal", isFinal: true, cumulative: true },
    });
    expect(orchestrator.snapshot.providerResponseClosed).toBe(false);

    // Second response turn (AI responds with fresh resp ID and null turnId)
    now = 3;
    const nullTurnIdentity2: GenerationIdentity = {
      sessionGeneration: "session-1",
      turnId: null,
      providerResponseId: "resp-null-2",
      playbackGeneration: null,
    };
    publishAdapterEvent(bus, now, audioEvent(nullTurnIdentity2));
    expect(playbackEvents).toHaveLength(2);
    expect(orchestrator.snapshot.providerResponseClosed).toBe(false);

    // Late PCM from first closed response is still rejected
    now = 4;
    publishAdapterEvent(bus, now, audioEvent(nullTurnIdentity1));
    expect(playbackEvents).toHaveLength(2);
    expect(staleEvents).toHaveLength(1);
  });

  it("allows multiple consecutive voice turns with null turn IDs without locking into IDLE", () => {
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

    const nullIdentity: GenerationIdentity = {
      sessionGeneration: "session-1",
      turnId: null,
      providerResponseId: null,
      playbackGeneration: null,
    };

    // First conversation turn
    publishAdapterEvent(bus, now, audioEvent(nullIdentity));
    expect(playbackEvents).toHaveLength(1);
    expect(orchestrator.state).toBe("ASSISTANT_SPEAKING");

    now = 1;
    publishAdapterEvent(bus, now, completeEvent(nullIdentity));
    expect(orchestrator.state).toBe("LISTENING");
    expect(orchestrator.snapshot.providerResponseClosed).toBe(true);

    // User speaks, audio/transcript events arrive with null turn/response IDs
    now = 2;
    publishAdapterEvent(bus, now, {
      type: "PROVIDER_INPUT_TRANSCRIPT",
      identity: nullIdentity,
      payload: { text: "What is the weather?", isFinal: true, cumulative: true },
    });
    expect(orchestrator.state).toBe("THINKING");

    // Second conversation turn: Model responds
    now = 3;
    publishAdapterEvent(bus, now, audioEvent(nullIdentity));
    expect(playbackEvents).toHaveLength(2);
    expect(orchestrator.state).toBe("ASSISTANT_SPEAKING");

    now = 4;
    publishAdapterEvent(bus, now, completeEvent(nullIdentity));
    expect(orchestrator.state).toBe("LISTENING");

    // Third conversation turn: User speaks again, Model responds again
    now = 5;
    publishAdapterEvent(bus, now, {
      type: "PROVIDER_INPUT_TRANSCRIPT",
      identity: nullIdentity,
      payload: { text: "Tell me a joke.", isFinal: true, cumulative: true },
    });
    expect(orchestrator.state).toBe("THINKING");

    now = 6;
    publishAdapterEvent(bus, now, audioEvent(nullIdentity));
    expect(playbackEvents).toHaveLength(3);
    expect(orchestrator.state).toBe("ASSISTANT_SPEAKING");

    now = 7;
    publishAdapterEvent(bus, now, completeEvent(nullIdentity));
    expect(orchestrator.state).toBe("LISTENING");
    expect(staleEvents).toHaveLength(0);
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

  it("interrupts active playback locally after confirmed user speech", () => {
    let now = 0;
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const flushes: unknown[] = [];
    bus.subscribe((envelope) => flushes.push(envelope.payload), {
      topic: "voice.playback",
      messageType: "ORCHESTRATOR_FLUSH_PLAYBACK",
    });
    const orchestrator = new VoiceOrchestrator({ bus, nowMono: () => now });

    publishAdapterEvent(bus, now, audioEvent(sessionIdentity));
    const oldGeneration = orchestrator.identity.playbackGeneration;
    expect(orchestrator.state).toBe("ASSISTANT_SPEAKING");

    publishCaptureFrame(bus, ++now, 0.03);
    publishCaptureFrame(bus, ++now, 0.07);
    publishCaptureFrame(bus, ++now, 0.08);
    publishCaptureFrame(bus, ++now, 0.08);

    expect(flushes).toHaveLength(1);
    expect((flushes[0] as { reason?: string }).reason).toBe("local-capture");
    expect((flushes[0] as { oldPlaybackGeneration?: string }).oldPlaybackGeneration).toBe(oldGeneration);
    expect(orchestrator.identity.playbackGeneration).not.toBe(oldGeneration);
    expect(orchestrator.state).toBe("INTERRUPTED");

    publishCaptureFrame(bus, ++now, 0.08, true);
    expect(flushes).toHaveLength(1);
  });

  it("suppresses native cue transcripts while routing native cue audio", () => {
    let now = 0;
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const outputs: unknown[] = [];
    const audio: unknown[] = [];
    const completions: unknown[] = [];
    bus.subscribe((envelope) => outputs.push(envelope.payload), {
      topic: "voice.transcript",
      messageType: "ORCHESTRATOR_OUTPUT_TRANSCRIPT",
    });
    bus.subscribe((envelope) => audio.push(envelope.payload), {
      topic: "voice.playback",
      messageType: "ORCHESTRATOR_AUDIO_EVENT",
    });
    bus.subscribe((envelope) => completions.push(envelope.payload), {
      topic: "voice.provider",
      messageType: "ORCHESTRATOR_GEMINI_CUE_COMPLETE",
    });
    const orchestrator = new VoiceOrchestrator({ bus, nowMono: () => now });

    bus.publish(createEventEnvelope({
      messageId: "cue-request",
      messageType: "BACKCHANNEL_CUE_REQUESTED",
      sourceLayer: "backchannel",
      topic: "voice.playback",
      priority: "high",
      timestampMono: now,
      ttlMs: 10_000,
      identity: sessionIdentity,
      correlationId: "orchestrator-test",
      payload: {
        cueText: "mhm",
        delivery: "gemini-native",
        reason: "natural-pause",
        cueIdentity: {
          ...sessionIdentity,
          cueId: "cue-1",
          cueSource: "native",
          cueLane: "backchannel",
          createdAtMono: now,
          expiresAtMono: now + 5_000,
        },
      },
    }));
    expect(completions).toHaveLength(0);

    const cueIdentity = { ...sessionIdentity, providerResponseId: "cue-response-1" };
    publishAdapterEvent(bus, ++now, {
      type: "PROVIDER_OUTPUT_TRANSCRIPT",
      identity: cueIdentity,
      payload: { text: "mhm", isFinal: true, cumulative: true },
    });
    publishAdapterEvent(bus, ++now, audioEvent(cueIdentity));
    expect(outputs).toHaveLength(0);
    expect(audio).toHaveLength(1);

    publishAdapterEvent(bus, ++now, completeEvent(cueIdentity));
    expect(completions).toHaveLength(1);
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


describe("VoiceOrchestrator delayed provider output fencing", () => {
  it("rejects anonymous output after completion until fresh user speech arrives", () => {
    let now = 0;
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const outputs: unknown[] = [];
    const staleEvents: unknown[] = [];
    bus.subscribe((envelope) => outputs.push(envelope.payload), {
      topic: "voice.transcript",
      messageType: "ORCHESTRATOR_OUTPUT_TRANSCRIPT",
    });
    bus.subscribe((envelope) => staleEvents.push(envelope.payload), {
      topic: "voice.orchestrator",
      messageType: "ORCHESTRATOR_STALE_REJECTED",
    });
    const orchestrator = new VoiceOrchestrator({ bus, nowMono: () => now });
    const greeting: GenerationIdentity = {
      sessionGeneration: "session-1",
      turnId: null,
      providerResponseId: "greeting-response",
      playbackGeneration: null,
    };

    publishAdapterEvent(bus, now, audioEvent(greeting));
    now = 1;
    publishAdapterEvent(bus, now, completeEvent(greeting));
    expect(orchestrator.state).toBe("LISTENING");

    now = 2;
    publishAdapterEvent(bus, now, {
      type: "PROVIDER_OUTPUT_TRANSCRIPT",
      identity: { sessionGeneration: "session-1", turnId: null, providerResponseId: null, playbackGeneration: null },
      payload: { text: "late greeting transcript", isFinal: true, cumulative: true },
    });
    expect(outputs).toHaveLength(0);
    expect(staleEvents).toHaveLength(1);
    expect(orchestrator.state).toBe("LISTENING");

    now = 3;
    publishCaptureFrame(bus, now, 0.1);
    now = 4;
    publishAdapterEvent(bus, now, {
      type: "PROVIDER_OUTPUT_TRANSCRIPT",
      identity: { sessionGeneration: "session-1", turnId: null, providerResponseId: "response-2", playbackGeneration: null },
      payload: { text: "new response", isFinal: false, cumulative: true },
    });
    expect(outputs).toHaveLength(1);
    expect(orchestrator.state).toBe("ASSISTANT_SPEAKING");
  });
});


describe("VoiceOrchestrator playback-drain completion", () => {
  it("returns to listening after generationComplete and matching playback drain", () => {
    let now = 0;
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const orchestrator = new VoiceOrchestrator({ bus, nowMono: () => now });
    const identity: GenerationIdentity = {
      sessionGeneration: "session-1",
      turnId: "turn-1",
      providerResponseId: "response-1",
      playbackGeneration: null,
    };

    publishAdapterEvent(bus, now, audioEvent(identity));
    const generation = orchestrator.identity.playbackGeneration;
    expect(orchestrator.state).toBe("ASSISTANT_SPEAKING");
    expect(generation).toBeTruthy();

    publishAdapterEvent(bus, ++now, {
      type: "PROVIDER_GENERATION_COMPLETE",
      identity: { ...identity, playbackGeneration: generation },
      payload: {},
    });
    expect(orchestrator.state).toBe("ASSISTANT_SPEAKING");

    bus.publish(createEventEnvelope({
      messageId: "playback-drained",
      messageType: "playback.state",
      sourceLayer: "playback",
      topic: "voice.playback",
      priority: "high",
      timestampMono: ++now,
      ttlMs: 10_000,
      identity: { ...identity, playbackGeneration: generation },
      correlationId: "orchestrator-test",
      payload: {
        state: "IDLE",
        queueDepthMs: 0,
        activeGenerationId: generation,
        mainGain: 1,
        backchannelGain: 0.4,
        scheduledSources: 0,
      },
    }));

    expect(orchestrator.state).toBe("LISTENING");
    expect(orchestrator.snapshot.providerResponseClosed).toBe(true);
  });
});
