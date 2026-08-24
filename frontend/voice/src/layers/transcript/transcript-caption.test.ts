import { describe, expect, it } from "vitest";
import type { GenerationIdentity, LayerLinkEnvelope } from "../../core/layer-link";
import { createEventEnvelope, LayerLinkMessageBus } from "../../core/message-bus";
import type { VoiceEvent } from "../adapter/event-types";
import { CaptionPacer } from "../caption/pacer";
import { AssistantAssembler } from "./assistant-assembler";
import { UserAssembler } from "./user-assembler";

const identity: GenerationIdentity = {
  sessionGeneration: "session-1",
  turnId: "turn-1",
  providerResponseId: "response-1",
  playbackGeneration: "generation-1",
};

function assistantEvent(
  text: string,
  options: { readonly isFinal?: boolean; readonly cumulative?: boolean } = {},
): VoiceEvent {
  return {
    type: "PROVIDER_OUTPUT_TRANSCRIPT",
    identity,
    payload: {
      text,
      isFinal: options.isFinal ?? false,
      cumulative: options.cumulative ?? true,
    },
  };
}

function publishOutput(bus: LayerLinkMessageBus, event: VoiceEvent, nowMono: number): void {
  bus.publish(
    createEventEnvelope({
      messageId: `output-${nowMono}`,
      messageType: "ORCHESTRATOR_OUTPUT_TRANSCRIPT",
      sourceLayer: "orchestrator",
      targetLayer: "transcript",
      topic: "voice.transcript",
      priority: "normal",
      timestampMono: nowMono,
      ttlMs: 10_000,
      identity: event.identity,
      correlationId: "transcript-test",
      payload: { event },
    }),
  );
}

function publishPlaybackScheduled(
  bus: LayerLinkMessageBus,
  nowMono: number,
  generationId = "generation-1",
): void {
  bus.publish(
    createEventEnvelope({
      messageId: `scheduled-${nowMono}`,
      messageType: "playback.chunk-scheduled",
      sourceLayer: "playback",
      targetLayer: "caption",
      topic: "voice.playback",
      priority: "high",
      timestampMono: nowMono,
      ttlMs: 10_000,
      identity: { ...identity, playbackGeneration: generationId },
      correlationId: "playback-test",
      payload: {
        chunkId: `audio-${nowMono}`,
        lane: "main",
        generationId,
        startTime: nowMono / 1_000,
      },
    }),
  );
}

describe("transcript assemblers", () => {
  it("reconciles incremental assistant text and a cumulative final snapshot into one final text", () => {
    const updates: string[] = [];
    const finals: string[] = [];
    const assembler = new AssistantAssembler({
      onUpdate: (update) => {
        updates.push(update.text);
        if (update.isFinal) finals.push(update.text);
      },
    });

    assembler.consume(assistantEvent("I hear", { cumulative: false }));
    assembler.consume(assistantEvent("I hear you, please continue.", { cumulative: true, isFinal: true }));
    const duplicate = assembler.consume(
      assistantEvent("I hear you, please continue.", { cumulative: true, isFinal: true }),
    );

    expect(updates).toEqual(["I hear", "I hear you, please continue."]);
    expect(finals).toEqual(["I hear you, please continue."]);
    expect(duplicate).toBeNull();
    expect(assembler.finalizedTurns.size).toBe(1);
  });

  it("rejects duplicate user finals and input transcripts crossing the mute boundary", () => {
    const diagnostics: string[] = [];
    const updates: string[] = [];
    const assembler = new UserAssembler({
      onUpdate: (update) => updates.push(update.text),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.type),
    });
    const final: VoiceEvent = {
      type: "PROVIDER_INPUT_TRANSCRIPT",
      identity,
      payload: { text: "finished", isFinal: true, cumulative: true },
    };

    assembler.consume(final, { receivedAtMono: 100 });
    assembler.consume(final, { receivedAtMono: 101 });
    assembler.consume(
      {
        ...final,
        payload: { text: "late muted speech", isFinal: false, cumulative: true },
      },
      { mutedAtMono: 200, receivedAtMono: 201 },
    );

    expect(updates).toEqual(["finished"]);
    expect(diagnostics).toEqual([
      "transcript.duplicate_final.rejected",
      "transcript.muted_race.rejected",
    ]);
  });
});

describe("CaptionPacer", () => {
  it("holds assistant captions until a matching playback chunk is scheduled", () => {
    let now = 100;
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const released: string[] = [];
    bus.subscribe<{ readonly caption?: { readonly text?: string } }>((envelope) => {
      if (envelope.messageType === "caption.released") {
        const payload = envelope.payload as { readonly caption: { readonly text: string } };
        released.push(payload.caption.text);
      }
    }, { topic: "voice.caption", messageType: "caption.released" });
    const pacer = new CaptionPacer({ bus, nowMono: () => now });

    publishOutput(bus, assistantEvent("Hello there", { cumulative: true }), now);
    expect(released).toEqual([]);
    expect(pacer.snapshot.pendingQueueDepth).toBe(1);

    now = 120;
    publishPlaybackScheduled(bus, now);
    expect(released).toEqual(["Hello there"]);
    expect(pacer.snapshot.pendingQueueDepth).toBe(0);
    expect(pacer.snapshot.lastReleasedCaption).toBe("Hello there");
  });

  it("drops captions for closed turns and stale playback generations", () => {
    let now = 0;
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const staleReasons: string[] = [];
    bus.subscribe<unknown>((envelope: LayerLinkEnvelope<unknown>) => {
      if (envelope.messageType === "caption.stale.rejected") {
        const payload = envelope.payload as { readonly reason: string };
        staleReasons.push(payload.reason);
      }
    }, { topic: "voice.caption", messageType: "caption.stale.rejected" });
    const pacer = new CaptionPacer({ bus, nowMono: () => now });

    publishOutput(bus, assistantEvent("closed response"), now);
    bus.publish(
      createEventEnvelope({
        messageId: "close-turn",
        messageType: "ORCHESTRATOR_TRANSCRIPT_EVENT",
        sourceLayer: "orchestrator",
        targetLayer: "caption",
        topic: "voice.transcript",
        priority: "high",
        timestampMono: now,
        ttlMs: 10_000,
        identity,
        correlationId: "close-test",
        payload: {
          event: {
            type: "PROVIDER_TURN_COMPLETE",
            identity,
            payload: {},
          } satisfies VoiceEvent,
        },
      }),
    );
    expect(pacer.snapshot.pendingQueueDepth).toBe(1);
    now = 1;
    publishOutput(bus, {
      ...assistantEvent("late closed response"),
      identity: { ...identity, providerResponseId: "response-late" },
    }, now);
    expect(staleReasons).toContain("closed-turn-or-stale-playback-generation");

    const staleIdentity = { ...identity, turnId: "turn-2", playbackGeneration: "generation-old" };
    const staleEvent: VoiceEvent = {
      type: "PROVIDER_OUTPUT_TRANSCRIPT",
      identity: staleIdentity,
      payload: { text: "old generation", isFinal: false, cumulative: true },
    };
    pacer.enqueue({
      text: staleEvent.payload.text,
      identity: staleIdentity,
      logicalTurnKey: "assistant:session-1:turn-2:response-1",
      revision: 1,
      isFinal: false,
      receivedAtMono: now,
    });
    publishPlaybackScheduled(bus, now + 1, "generation-new");
    expect(staleReasons).toContain("stale-playback-generation");
  });
});
