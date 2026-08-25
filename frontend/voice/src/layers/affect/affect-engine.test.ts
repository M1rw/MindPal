import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventEnvelope, LayerLinkMessageBus } from "../../core/message-bus";
import type { GenerationIdentity } from "../../core/layer-link";
import { AffectEngine, buildAffectPrompt } from "./affect-engine";

const identity: GenerationIdentity = {
  sessionGeneration: "test-session",
  turnId: "turn-1",
  providerResponseId: null,
  playbackGeneration: null,
};

function publishUserTranscript(bus: LayerLinkMessageBus, text: string, timestampMono: number): void {
  bus.publish(createEventEnvelope({
    messageId: `input-${timestampMono}-${text}`,
    messageType: "adapter.event",
    sourceLayer: "provider-adapter",
    topic: "voice.provider",
    priority: "normal",
    timestampMono,
    ttlMs: 10_000,
    identity,
    correlationId: "test",
    payload: {
      type: "PROVIDER_INPUT_TRANSCRIPT",
      identity,
      payload: { text, isFinal: true, cumulative: true },
    },
  }));
}

describe("AffectEngine", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves into confident banter when the user jokes and invites a challenge", () => {
    vi.useFakeTimers();
    let now = 1_000;
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const engine = new AffectEngine({ bus, nowMono: () => now, sessionGeneration: "test-affect" });

    publishUserTranscript(bus, "Haha, bet you can't impress me, genius!", now);
    vi.advanceTimersByTime(1_000);

    expect(engine.state.stance).toBe("confident-banter");
    expect(engine.state.playfulness).toBeGreaterThan(0.34);
    expect(buildAffectPrompt(engine.state)).toContain("light non-humiliating tease");
    engine.dispose();
  });

  it("raises a calm boundary instead of escalating repeated hostility", () => {
    vi.useFakeTimers();
    let now = 1_000;
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const engine = new AffectEngine({ bus, nowMono: () => now, sessionGeneration: "test-affect" });

    for (let index = 0; index < 8; index += 1) {
      publishUserTranscript(bus, "You are stupid and worthless, shut up.", now);
      now += 1_000;
    }
    vi.runAllTimers();

    expect(engine.state.stance).toBe("calm-firm");
    expect(engine.state.boundaryPressure).toBeGreaterThan(0.58);
    expect(buildAffectPrompt(engine.state)).toContain("Never humiliate, threaten, retaliate, or become abusive");
    engine.dispose();
  });

  it("selects gentle concern for a clear distress signal", () => {
    vi.useFakeTimers();
    let now = 1_000;
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const engine = new AffectEngine({ bus, nowMono: () => now, sessionGeneration: "test-affect" });

    publishUserTranscript(bus, "I feel overwhelmed, alone, and exhausted.", now);
    vi.advanceTimersByTime(1_000);

    expect(engine.state.stance).toBe("gentle-concern");
    expect(engine.state.feelings.empathy).toBeGreaterThan(0.7);
    expect(engine.state.feelings.concern).toBeGreaterThan(0.5);
    engine.dispose();
  });

  it("emits affect context updates with bounded rate and versioned state", () => {
    vi.useFakeTimers();
    let now = 1_000;
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const contexts: unknown[] = [];
    bus.subscribe((envelope) => contexts.push(envelope.payload), {
      topic: "voice.transport",
      messageType: "affect.context.updated",
    });
    const engine = new AffectEngine({ bus, nowMono: () => now, sessionGeneration: "test-affect", contextCooldownMs: 200 });

    publishUserTranscript(bus, "Haha, this is funny!", now);
    vi.advanceTimersByTime(199);
    expect(contexts).toHaveLength(0);
    vi.runAllTimers();
    expect(contexts).toHaveLength(1);
    const payload = contexts[0] as { version: number; prompt: string };
    expect(payload.version).toBeGreaterThan(0);
    expect(payload.prompt).toContain("AFFECT_CONTEXT_UPDATE");
    engine.dispose();
  });
});
