import { describe, expect, it } from "vitest";
import { createEventEnvelope, LayerLinkMessageBus } from "../../core/message-bus";
import { FaceLayer } from "./face-layer";

describe("FaceLayer", () => {
  it("initializes with neutral expression", () => {
    const bus = new LayerLinkMessageBus({ nowMono: () => 100 });
    const face = new FaceLayer({ bus, nowMono: () => 100 });

    expect(face.state.expression).toBe("neutral");
    expect(face.state.theme).toBe("geminiCore");
  });

  it("classifies AI speaking tone based on response content", () => {
    const bus = new LayerLinkMessageBus({ nowMono: () => 100 });
    const face = new FaceLayer({ bus, nowMono: () => 100 });

    face.processPhaseAndState("speaking", true, false);
    face.processAiTranscript("That is brilliant and amazing!");

    expect(face.state.expression).toBe("starstruck");
    expect(face.state.aiToneGuess).toBe("excited");

    face.processAiTranscript("I have a wonderful new idea, eureka!");
    expect(face.state.expression).toBe("epiphany");
  });

  it("consumes the production assistant transcript topic", () => {
    const bus = new LayerLinkMessageBus({ nowMono: () => 100 });
    const face = new FaceLayer({ bus, nowMono: () => 100 });
    face.processPhaseAndState("speaking", true, false);

    bus.publish(createEventEnvelope({
      messageId: "assistant-transcript",
      messageType: "transcript.assistant.updated",
      sourceLayer: "transcript",
      topic: "voice.transcript",
      priority: "normal",
      timestampMono: 100,
      ttlMs: 1_000,
      identity: { sessionGeneration: "session-1", turnId: null, providerResponseId: null, playbackGeneration: null },
      correlationId: "face-test",
      payload: { text: "That is brilliant and amazing!" },
    }));

    expect(face.state.expression).toBe("starstruck");
  });

  it("classifies listening expressions based on user input and prosody", () => {
    const bus = new LayerLinkMessageBus({ nowMono: () => 100 });
    const face = new FaceLayer({ bus, nowMono: () => 100 });

    face.processPhaseAndState("listening", false, false);
    face.processUserTranscript("I am so frustrated and stuck!");

    expect(face.state.expression).toBe("sympathetic");
  });

  it("handles error, connecting, and muted states", () => {
    const bus = new LayerLinkMessageBus({ nowMono: () => 100 });
    const face = new FaceLayer({ bus, nowMono: () => 100 });

    face.processPhaseAndState("connecting", false, false);
    expect(face.state.expression).toBe("circleLoading");

    face.processPhaseAndState("error", false, false);
    expect(face.state.expression).toBe("dead");

    face.processPhaseAndState("listening", false, true);
    expect(face.state.expression).toBe("sleepy");
  });
});
