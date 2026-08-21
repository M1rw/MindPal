import { describe, expect, it } from "vitest";
import type { GenerationIdentity } from "../../core/layer-link";
import { createEventEnvelope, LayerLinkMessageBus } from "../../core/message-bus";
import type { VoiceEvent } from "../adapter/event-types";
import { SyntheticCueProvider } from "./cue-provider";
import {
  BackchannelConductor,
  CUE_COOLDOWN_MS,
  MAX_CUES_PER_WINDOW,
  type BackchannelCueRequestPayload,
} from "./conductor";

const baseIdentity: GenerationIdentity = {
  sessionGeneration: "session-test",
  turnId: "turn-test",
  providerResponseId: "response-test",
  playbackGeneration: "generation-test",
};

function publishFrame(
  bus: LayerLinkMessageBus,
  nowMono: number,
  rms: number,
  muted = false,
): void {
  bus.publish(
    createEventEnvelope({
      messageId: `frame-${nowMono}`,
      messageType: "capture.frame",
      sourceLayer: "capture",
      topic: "voice.capture",
      priority: "normal",
      timestampMono: nowMono,
      ttlMs: 10_000,
      identity: baseIdentity,
      correlationId: "capture-test",
      payload: {
        frameId: `frame-${nowMono}`,
        sequence: Math.floor(nowMono / 20),
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

function publishAdapterEvent(bus: LayerLinkMessageBus, nowMono: number, event: VoiceEvent): void {
  bus.publish(
    createEventEnvelope({
      messageId: `adapter-${nowMono}`,
      messageType: "adapter.event",
      sourceLayer: "provider-adapter",
      topic: "voice.provider",
      priority: "high",
      timestampMono: nowMono,
      ttlMs: 10_000,
      identity: baseIdentity,
      correlationId: "adapter-test",
      payload: event,
    }),
  );
}

function publishPlaybackState(bus: LayerLinkMessageBus, nowMono: number, speaking: boolean): void {
  bus.publish(
    createEventEnvelope({
      messageId: `playback-${nowMono}`,
      messageType: "playback.state",
      sourceLayer: "playback",
      topic: "voice.playback",
      priority: "telemetry",
      timestampMono: nowMono,
      ttlMs: 10_000,
      identity: baseIdentity,
      correlationId: "playback-test",
      payload: {
        state: speaking ? "PLAYING" : "IDLE",
        queueDepthMs: speaking ? 120 : 0,
        activeGenerationId: baseIdentity.playbackGeneration,
        mainGain: speaking ? 1 : 0,
        backchannelGain: 0.4,
        scheduledSources: speaking ? 1 : 0,
      },
    }),
  );
}

describe("SyntheticCueProvider", () => {
  it("creates a deterministic 300 ms, 440 Hz, 24 kHz backchannel PCM16 chunk", () => {
    const cue = new SyntheticCueProvider().createCue(baseIdentity, "cue-test");
    const samples = new Int16Array(cue.data);
    expect(cue.audioLane).toBe("backchannel");
    expect(cue.sampleRate).toBe(24_000);
    expect(cue.channels).toBe(1);
    expect(samples).toHaveLength(7_200);
    expect(samples.some((sample) => sample !== 0)).toBe(true);
    expect(samples[100]).not.toBe(samples[101]);
  });
});

describe("BackchannelConductor", () => {
  it("enters monitoring only after 2.5 seconds and requests a cue during a 200 ms natural pause", () => {
    let now = 0;
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const requests: BackchannelCueRequestPayload[] = [];
    bus.subscribe<BackchannelCueRequestPayload>((envelope) => {
      requests.push(envelope.payload);
    }, { topic: "voice.playback", messageType: "BACKCHANNEL_CUE_REQUESTED" });
    const conductor = new BackchannelConductor({
      bus,
      cueProvider: new SyntheticCueProvider(),
      nowMono: () => now,
    });

    publishFrame(bus, now, 0.1);
    expect(conductor.state).toBe("IDLE");
    for (now = 20; now <= 2_520; now += 20) publishFrame(bus, now, 0.1);
    expect(conductor.state).toBe("MONITORING");

    now = 2_650;
    publishFrame(bus, now, 0);
    now = 2_850;
    publishFrame(bus, now, 0.1);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.reason).toBe("natural-pause");
    expect(requests[0]?.cue.audioLane).toBe("backchannel");
    expect(conductor.snapshot.cuesTriggered).toBe(1);
    expect(conductor.state).toBe("COOLDOWN");
  });

  it("respects the four-second cooldown and three-cue rolling window in a 15-second monologue", () => {
    let now = 0;
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const requests: BackchannelCueRequestPayload[] = [];
    const suppressionReasons: string[] = [];
    bus.subscribe<BackchannelCueRequestPayload>((envelope) => {
      requests.push(envelope.payload);
    }, { topic: "voice.playback", messageType: "BACKCHANNEL_CUE_REQUESTED" });
    bus.subscribe<{ readonly reason?: string }>((envelope) => {
      if (envelope.messageType === "backchannel.cue.suppressed") {
        suppressionReasons.push(envelope.payload.reason ?? "unknown");
      }
    }, { topic: "voice.backchannel", messageType: "backchannel.cue.suppressed" });
    const conductor = new BackchannelConductor({
      bus,
      cueProvider: new SyntheticCueProvider(),
      nowMono: () => now,
    });

    publishFrame(bus, now, 0.1);
    for (now = 20; now <= 2_520; now += 20) publishFrame(bus, now, 0.1);

    const pauseAndResume = (pauseAt: number, resumeAt: number) => {
      now = pauseAt;
      publishFrame(bus, now, 0);
      now = resumeAt;
      publishFrame(bus, now, 0.1);
    };

    pauseAndResume(2_650, 2_850);
    pauseAndResume(4_400, 4_600);
    pauseAndResume(8_700, 8_900);
    pauseAndResume(13_000, 13_200);
    pauseAndResume(17_300, 17_500);

    expect(requests).toHaveLength(MAX_CUES_PER_WINDOW);
    expect(conductor.snapshot.cuesTriggered).toBe(3);
    expect(suppressionReasons).toContain("cooldown");
    expect(suppressionReasons).toContain("window-limit");
    expect(conductor.snapshot.cuesInRollingWindow).toBe(3);
    expect(CUE_COOLDOWN_MS).toBe(4_000);
  });

  it("suppresses cues while the main lane speaks and when silence exceeds 800 ms", () => {
    let now = 0;
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const requests: BackchannelCueRequestPayload[] = [];
    bus.subscribe<BackchannelCueRequestPayload>((envelope) => {
      requests.push(envelope.payload);
    }, { topic: "voice.playback", messageType: "BACKCHANNEL_CUE_REQUESTED" });
    const conductor = new BackchannelConductor({
      bus,
      cueProvider: new SyntheticCueProvider(),
      nowMono: () => now,
    });

    publishFrame(bus, now, 0.1);
    for (now = 20; now <= 2_520; now += 20) publishFrame(bus, now, 0.1);
    publishPlaybackState(bus, now, true);
    expect(conductor.snapshot.mainLaneSpeaking).toBe(true);
    now = 2_700;
    publishFrame(bus, now, 0);
    now = 2_900;
    publishFrame(bus, now, 0.1);
    expect(requests).toHaveLength(0);
    expect(conductor.snapshot.lastSuppressionReason).toBe("main-lane-speaking");

    publishPlaybackState(bus, now, false);
    now = 3_800;
    publishFrame(bus, now, 0);
    now = 4_601;
    publishFrame(bus, now, 0);
    expect(conductor.snapshot.lastSuppressionReason).toBe("silence-over-800ms");
    expect(conductor.state).toBe("SUPPRESSED");
  });

  it("suppresses the active turn on final input transcript and provider turn completion", () => {
    let now = 0;
    const bus = new LayerLinkMessageBus({ nowMono: () => now });
    const conductor = new BackchannelConductor({
      bus,
      cueProvider: new SyntheticCueProvider(),
      nowMono: () => now,
    });
    const finalInput: VoiceEvent = {
      type: "PROVIDER_INPUT_TRANSCRIPT",
      identity: baseIdentity,
      payload: { text: "finished", isFinal: true, cumulative: true },
    };
    publishAdapterEvent(bus, now, finalInput);
    expect(conductor.snapshot.lastSuppressionReason).toBe("final-transcript");

    now = 100;
    const complete: VoiceEvent = {
      type: "PROVIDER_TURN_COMPLETE",
      identity: baseIdentity,
      payload: {},
    };
    publishAdapterEvent(bus, now, complete);
    expect(conductor.snapshot.lastSuppressionReason).toBe("turn-complete");
    expect(conductor.snapshot.continuousSpeechMs).toBe(0);
  });
});
