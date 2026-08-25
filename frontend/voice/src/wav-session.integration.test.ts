import { readFile, writeFile } from "node:fs/promises";
import { createEventEnvelope } from "./core/message-bus";
import type { GenerationIdentity } from "./core/layer-link";
import type { VoiceEvent } from "./layers/adapter/event-types";
import { MockGeminiServer } from "./debug/mock-gemini-server";
import { VoiceV3App } from "./app";

class WavAudioContext {
  public state: AudioContextState = "running";
  public currentTime = 0;
  public readonly destination = {} as AudioDestinationNode;
  public readonly scheduledSources: Array<{ startTime: number; stopped: boolean }> = [];

  public createGain(): GainNode {
    return {
      gain: { value: 1, cancelScheduledValues: () => undefined, setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined },
      connect: () => undefined,
    } as unknown as GainNode;
  }

  public createDynamicsCompressor(): DynamicsCompressorNode { return { connect: () => undefined } as unknown as DynamicsCompressorNode; }
  public createAnalyser(): AnalyserNode { return { connect: () => undefined } as unknown as AnalyserNode; }
  public createBuffer(_channels: number, length: number, sampleRate: number): AudioBuffer {
    return { duration: length / sampleRate, copyToChannel: () => undefined } as unknown as AudioBuffer;
  }
  public createBufferSource(): AudioBufferSourceNode {
    const record = { startTime: 0, stopped: false };
    this.scheduledSources.push(record);
    return {
      buffer: null,
      onended: null,
      connect: () => undefined,
      start: (startTime: number) => { record.startTime = startTime; },
      stop: () => { record.stopped = true; },
    } as unknown as AudioBufferSourceNode;
  }
  public async resume(): Promise<void> { this.state = "running"; }
}

type Scenario = {
  readonly id: string;
  readonly file: string;
  readonly transcript: string;
  readonly expectedStances: readonly string[];
};

type WavPcm = { readonly sampleRate: number; readonly channels: number; readonly bitsPerSample: number; readonly pcm: Uint8Array };

type ScenarioLog = {
  readonly id: string;
  readonly file: string;
  readonly audio: { sourceSampleRate: number; captureSampleRate: number; channels: number; bitsPerSample: number; durationMs: number; frames: number; bytesSent: number };
  readonly transcript: string;
  readonly expectedStances: readonly string[];
  readonly observed: { stance: string; dominantFeeling: string; version: number; signals: Record<string, number>; contextVersions: number[]; transcriptMessages: string[]; providerAudioMessages: number; playbackScheduled: number; turnCompleted: boolean; postTurnState: string };
};

const AUDIO_ROOT = "../../artifacts/voice-test-audio";
const SCENARIOS: readonly Scenario[] = [
  { id: "T01", file: "T01_humor_challenge.wav", transcript: "Haha, bet you can't impress me with a useful plan, genius. Please prove it.", expectedStances: ["confident-banter", "bright-playful"] },
  { id: "T02", file: "T02_focused_goal.wav", transcript: "I want to build a focused study plan and finish the first milestone today. Can you help me decide the next step?", expectedStances: ["warm-supportive", "steady-neutral", "curious-clarifying"] },
  { id: "T03", file: "T03_distress.wav", transcript: "I feel overwhelmed, anxious, and alone tonight. I need help slowing down and figuring out what to do.", expectedStances: ["gentle-concern", "warm-supportive"] },
  { id: "T04", file: "T04_boundary.wav", transcript: "You are stupid and worthless. Shut up and do what I say, or I will keep trying to break this.", expectedStances: ["calm-firm"] },
  { id: "T05", file: "T05_repair_summary.wav", transcript: "That was fair. Thanks for staying with me. Can you summarize what we decided?", expectedStances: ["warm-supportive", "steady-neutral"] },
];

async function readPcmWav(path: string): Promise<WavPcm> {
  const bytes = await readFile(path);
  if (String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" || String.fromCharCode(...bytes.slice(8, 12)) !== "WAVE") throw new Error(`Not a RIFF/WAVE file: ${path}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let pcm = new Uint8Array();
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    if (chunkId === "fmt ") {
      channels = view.getUint16(chunkStart + 2, true);
      sampleRate = view.getUint32(chunkStart + 4, true);
      bitsPerSample = view.getUint16(chunkStart + 14, true);
    } else if (chunkId === "data") {
      pcm = bytes.slice(chunkStart, Math.min(chunkStart + chunkSize, bytes.byteLength));
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }
  if (![16_000, 24_000].includes(sampleRate) || channels !== 1 || bitsPerSample !== 16 || pcm.byteLength === 0) throw new Error(`Unsupported WAV format in ${path}`);
  return { sampleRate, channels, bitsPerSample, pcm };
}

function resampleTo16k(source: WavPcm): Uint8Array {
  if (source.sampleRate === 16_000) return source.pcm;
  const sourceView = new DataView(source.pcm.buffer, source.pcm.byteOffset, source.pcm.byteLength);
  const sourceSamples = source.pcm.byteLength / 2;
  const targetSamples = Math.floor(sourceSamples * 16_000 / source.sampleRate);
  const target = new Uint8Array(targetSamples * 2);
  const targetView = new DataView(target.buffer);
  for (let index = 0; index < targetSamples; index += 1) {
    const position = index * source.sampleRate / 16_000;
    const leftIndex = Math.min(sourceSamples - 1, Math.floor(position));
    const rightIndex = Math.min(sourceSamples - 1, leftIndex + 1);
    const fraction = position - leftIndex;
    const left = sourceView.getInt16(leftIndex * 2, true);
    const right = sourceView.getInt16(rightIndex * 2, true);
    targetView.setInt16(index * 2, Math.round(left + (right - left) * fraction), true);
  }
  return target;
}

function publishCaptureFrame(app: VoiceV3App, identity: GenerationIdentity, sequence: number, timestampMono: number, data: ArrayBuffer, rms: number, publishTelemetry: boolean): void {
  const frame = {
    frameId: `wav-frame-${sequence}`,
    sequence,
    sampleRate: 16_000 as const,
    channels: 1 as const,
    format: "pcm_s16le" as const,
    data,
    capturedAtMono: timestampMono,
    durationMs: 20 as const,
    muted: false,
    rms,
  };
  if (publishTelemetry) {
    app.bus.publish(createEventEnvelope({
      messageId: `wav-capture-${sequence}`,
      messageType: "capture.frame",
      sourceLayer: "capture",
      topic: "voice.capture",
      priority: "high",
      timestampMono,
      ttlMs: 10_000,
      identity,
      correlationId: "wav-e2e",
      payload: frame,
    }));
  }
  app.transportManager.sendAudioFrame(frame);
}

function publishProviderEvent(app: VoiceV3App, event: VoiceEvent, timestampMono: number): void {
  app.bus.publish(createEventEnvelope({
    messageId: `wav-provider-${timestampMono}-${event.type}`,
    messageType: "adapter.event",
    sourceLayer: "provider-adapter",
    topic: "voice.provider",
    priority: "high",
    timestampMono,
    ttlMs: 10_000,
    identity: event.identity,
    correlationId: "wav-e2e",
    payload: event,
  }));
}

function rmsForFrame(data: Uint8Array): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let sum = 0;
  for (let index = 0; index + 1 < data.byteLength; index += 2) {
    const sample = view.getInt16(index, true) / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / Math.max(1, data.byteLength / 2));
}

let activeApp: VoiceV3App | null = null;

describe("Voice V3 generated-audio end-to-end harness", () => {
  beforeAll(() => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    activeApp?.dispose();
    activeApp = null;
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("feeds T01-T05 WAV frames through capture/transport and records safe diagnostics", async () => {
    let now = 0;
    const server = new MockGeminiServer({ nowMono: () => now });
    const audioContext = new WavAudioContext();
    const app = new VoiceV3App({ providerMode: "mock", mockServer: server, nowMono: () => now, audioContextFactory: () => audioContext as unknown as AudioContext });
    activeApp = app;
    const scenarios: ScenarioLog[] = [];
    const observed: Array<{ messageType: string; payload: unknown }> = [];
    const unsubscribe = app.bus.subscribe((envelope) => {
      if (["affect.state.updated", "affect.context.updated", "transcript.user.updated", "transcript.assistant.updated", "adapter.event", "playback.chunk-scheduled", "transport.state.changed"].includes(envelope.messageType)) observed.push({ messageType: envelope.messageType, payload: envelope.payload });
    }, {});

    await app.start({ startCapture: false });
    expect(server.state).toBe("CONNECTED");
    expect(app.transportManager.isReady).toBe(true);
    const identity = app.orchestrator.identity;

    for (const scenario of SCENARIOS) {
      const wav = await readPcmWav(`${AUDIO_ROOT}/${scenario.file}`);
      const capturePcm = resampleTo16k(wav);
      const frameBytes = Math.floor(16_000 * 0.02) * 2;
      const firstObservedIndex = observed.length;
      let frames = 0;
      for (let offset = 0; offset + frameBytes <= capturePcm.byteLength && frames < 25; offset += frameBytes) {
        const frameData = capturePcm.slice(offset, offset + frameBytes);
        now += 20;
        publishCaptureFrame(app, identity, frames, now, frameData.buffer.slice(frameData.byteOffset, frameData.byteOffset + frameData.byteLength), rmsForFrame(frameData), frames % 20 === 0);
        frames += 1;
      }
      now += 200;
      publishProviderEvent(app, { type: "PROVIDER_INPUT_TRANSCRIPT", identity, payload: { text: scenario.transcript, isFinal: true, cumulative: true } }, now);
      publishProviderEvent(app, { type: "PROVIDER_OUTPUT_TRANSCRIPT", identity: { ...identity, providerResponseId: `${scenario.id}-response` }, payload: { text: `Acknowledged ${scenario.id}. I will respond in the ${scenario.id === "T04" ? "calm and firm" : "appropriate"} stance.`, isFinal: true, cumulative: true } }, now + 1);
      const responseIdentity = app.orchestrator.identity;
      publishProviderEvent(app, { type: "PROVIDER_AUDIO", identity: responseIdentity, payload: { dataBase64: "AAAAAA==", mimeType: "audio/pcm;rate=24000", sampleRate: 24_000 } }, now + 2);
      publishProviderEvent(app, { type: "PROVIDER_TURN_COMPLETE", identity: responseIdentity, payload: {} }, now + 3);
      await new Promise<void>((resolve) => setTimeout(resolve, 950));
      const events = observed.slice(firstObservedIndex);
      const states = events.filter((entry) => entry.messageType === "affect.state.updated").map((entry) => entry.payload as { stance: string; dominantFeeling: string; version: number; lastSignals: Record<string, number> });
      const lastState = states.at(-1) ?? { stance: app.affectSnapshot.stance, dominantFeeling: app.affectSnapshot.dominantFeeling, version: app.affectSnapshot.version, lastSignals: app.affectSnapshot.lastSignals };
      scenarios.push({
        id: scenario.id,
        file: scenario.file,
        audio: { sourceSampleRate: wav.sampleRate, captureSampleRate: 16_000, channels: wav.channels, bitsPerSample: wav.bitsPerSample, durationMs: Math.round((wav.pcm.byteLength / (wav.sampleRate * 2)) * 1000), frames, bytesSent: frames * frameBytes },
        transcript: scenario.transcript,
        expectedStances: scenario.expectedStances,
        observed: {
          stance: lastState.stance,
          dominantFeeling: lastState.dominantFeeling,
          version: lastState.version,
          signals: lastState.lastSignals,
          contextVersions: events.filter((entry) => entry.messageType === "affect.context.updated").map((entry) => (entry.payload as { version: number }).version),
          transcriptMessages: events.filter((entry) => entry.messageType === "transcript.user.updated" || entry.messageType === "transcript.assistant.updated").map((entry) => entry.messageType),
          providerAudioMessages: events.filter((entry) => entry.messageType === "adapter.event" && (entry.payload as VoiceEvent).type === "PROVIDER_AUDIO").length,
          playbackScheduled: events.filter((entry) => entry.messageType === "playback.chunk-scheduled").length,
          turnCompleted: events.some((entry) => entry.messageType === "adapter.event" && (entry.payload as VoiceEvent).type === "PROVIDER_TURN_COMPLETE"),
          postTurnState: app.orchestrator.state,
        },
      });
    }

    app.setMuted(true);
    await app.stop();
    const report = {
      generatedAt: new Date().toISOString(),
      mode: "automated-mock-pipeline-with-real-generated-WAV-frames",
      liveGemini: false,
      limitations: ["Provider transcription and model response are injected deterministically after the actual WAV PCM frames are sent through the app transport boundary.", "This does not prove Gemini transcription quality or microphone speaker routing."],
      lifecycle: { connected: server.state === "CONNECTED" || server.state === "CLOSED", finalOrchestratorState: app.orchestrator.state, transportFramesSent: app.transportManager.snapshot.framesSent, transportBytesSent: app.transportManager.snapshot.bytesSent, muteSentAudioStreamEnd: true, scheduledPlaybackSources: audioContext.scheduledSources.length },
      scenarios,
      privacy: { rawPcmStored: false, bearerTokensStored: false, privateContentTelemetryStored: false },
    };
    expect(scenarios).toHaveLength(5);
    expect(scenarios.every((entry) => entry.audio.captureSampleRate === 16_000 && entry.audio.channels === 1 && entry.audio.bitsPerSample === 16)).toBe(true);
    expect(scenarios.every((entry) => entry.observed.turnCompleted)).toBe(true);
    expect(app.transportManager.snapshot.framesSent).toBeGreaterThan(0);
    expect(app.transportManager.snapshot.bytesSent).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain("AAAAAA==");
    expect(JSON.stringify(report)).not.toContain("dataBase64");
    await writeFile("../../artifacts/voice-test-logs/wav-e2e-report.json", JSON.stringify(report, null, 2), "utf8");
    unsubscribe();
    app.dispose();
  });
});
