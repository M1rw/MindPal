import { describe, expect, it } from "vitest";
import { createEventEnvelope } from "./core/message-bus";
import type { GenerationIdentity } from "./core/layer-link";
import { MockGeminiServer } from "./debug/mock-gemini-server";
import { VoiceV3App } from "./app";

class IntegrationAudioContext {
  public state: AudioContextState = "running";
  public currentTime = 0;
  public readonly destination = {} as AudioDestinationNode;
  public readonly scheduledSources: Array<{ startTime: number; duration: number; stopped: boolean }> = [];

  public createGain(): GainNode {
    return {
      gain: {
        value: 1,
        cancelScheduledValues: () => undefined,
        setValueAtTime: () => undefined,
        linearRampToValueAtTime: () => undefined,
      },
      connect: () => undefined,
    } as unknown as GainNode;
  }

  public createDynamicsCompressor(): DynamicsCompressorNode {
    return { connect: () => undefined } as unknown as DynamicsCompressorNode;
  }

  public createAnalyser(): AnalyserNode {
    return { connect: () => undefined } as unknown as AnalyserNode;
  }

  public createBuffer(_channels: number, length: number, sampleRate: number): AudioBuffer {
    return {
      duration: length / sampleRate,
      copyToChannel: () => undefined,
    } as unknown as AudioBuffer;
  }

  public createBufferSource(): AudioBufferSourceNode {
    const record = { startTime: 0, duration: 0, stopped: false };
    this.scheduledSources.push(record);
    return {
      buffer: null,
      onended: null,
      connect: () => undefined,
      start: (startTime: number) => {
        record.startTime = startTime;
        record.duration = 0.001;
      },
      stop: () => {
        record.stopped = true;
      },
    } as unknown as AudioBufferSourceNode;
  }

  public async resume(): Promise<void> {
    this.state = "running";
  }
}

function publishCaptureFrame(app: VoiceV3App, identity: GenerationIdentity, timestampMono: number, sequence: number, rms: number): void {
  app.bus.publish(
    createEventEnvelope({
      messageId: `integration-frame-${sequence}`,
      messageType: "capture.frame",
      sourceLayer: "capture",
      topic: "voice.capture",
      priority: "high",
      timestampMono,
      ttlMs: 10_000,
      identity,
      correlationId: "integration",
      payload: {
        frameId: `integration-frame-${sequence}`,
        sequence,
        sampleRate: 16_000,
        channels: 1,
        format: "pcm_s16le",
        data: new ArrayBuffer(640),
        capturedAtMono: timestampMono,
        durationMs: 20,
        muted: false,
        rms,
      },
    }),
  );
}

describe("Voice V3 MockGeminiServer integration", () => {
  it("boots, greets, backchannels, responds, interrupts, replaces, and completes a turn", async () => {
    let now = 0;
    const server = new MockGeminiServer({ nowMono: () => now });
    const audioContext = new IntegrationAudioContext();
    const messages: string[] = [];
    const app = new VoiceV3App({
      providerMode: "mock",
      mockServer: server,
      nowMono: () => now,
      audioContextFactory: () => audioContext as unknown as AudioContext,
    });
    app.bus.subscribe((envelope) => messages.push(envelope.messageType), {});

    await app.start({ startCapture: false });
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(server.state).toBe("CONNECTED");
    expect(app.transportManager.isReady).toBe(true);
    expect(messages).toContain("PROVIDER_READY");
    expect(messages).toContain("ORCHESTRATOR_OUTPUT_TRANSCRIPT");
    expect(app.orchestrator.state).toBe("LISTENING");

    const identity = app.orchestrator.identity;
    const greetingGeneration = app.playbackManager.snapshot.activeGenerationId;
    if (greetingGeneration) app.playbackManager.flush(greetingGeneration);
    app.bus.publish(
      createEventEnvelope({
        messageId: "playback-idle",
        messageType: "playback.state",
        sourceLayer: "playback",
        topic: "voice.playback",
        priority: "high",
        timestampMono: now,
        ttlMs: 10_000,
        identity,
        correlationId: "integration",
        payload: {
          state: "IDLE",
          queueDepthMs: 0,
          activeGenerationId: null,
          mainGain: 1,
          backchannelGain: 0.4,
          scheduledSources: 0,
        },
      }),
    );
    for (let sequence = 0; sequence < 130; sequence += 1) {
      now += 20;
      publishCaptureFrame(app, identity, now, sequence, 0.1);
    }
    now += 200;
    publishCaptureFrame(app, identity, now, 130, 0);
    now += 200;
    publishCaptureFrame(app, identity, now, 131, 0.1);
    expect(messages).toContain("BACKCHANNEL_CUE_REQUESTED");
    expect(messages).toContain("ORCHESTRATOR_GEMINI_CUE_REQUESTED");

    server.simulateUserSpeech();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(messages).toContain("ORCHESTRATOR_AUDIO_EVENT");
    expect(audioContext.scheduledSources.length).toBeGreaterThan(0);

    const previousPlaybackGeneration = app.orchestrator.identity.playbackGeneration;
    server.simulateInterruption();
    await Promise.resolve();
    expect(messages).toContain("ORCHESTRATOR_FLUSH_PLAYBACK");
    expect(app.orchestrator.identity.playbackGeneration).not.toBe(previousPlaybackGeneration);
    expect(app.orchestrator.state).toBe("ASSISTANT_SPEAKING");

    server.simulateTurnComplete();
    expect(app.orchestrator.state).toBe("LISTENING");
    expect(app.orchestrator.snapshot.providerResponseClosed).toBe(true);

    app.dispose();
  });
});
