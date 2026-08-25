import { readFile } from "node:fs/promises";
import { MockGeminiServer } from "./debug/mock-gemini-server";
import { VoiceV3App } from "./app";

class RawPipelineAudioContext {
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

type Wav = { sampleRate: number; channels: number; bitsPerSample: number; pcm: Uint8Array };

const ROOT = "../../artifacts/voice-test-audio";
const FILES = [
  "T01_humor_challenge.wav",
  "T02_focused_goal.wav",
  "T03_distress.wav",
  "T04_boundary.wav",
  "T05_repair_summary.wav",
] as const;

async function readWav(path: string): Promise<Wav> {
  const bytes = await readFile(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" || String.fromCharCode(...bytes.slice(8, 12)) !== "WAVE") throw new Error(`Invalid WAV: ${path}`);
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let pcm = new Uint8Array();
  while (offset + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (id === "fmt ") {
      channels = view.getUint16(start + 2, true);
      sampleRate = view.getUint32(start + 4, true);
      bitsPerSample = view.getUint16(start + 14, true);
    }
    if (id === "data") pcm = bytes.slice(start, Math.min(start + size, bytes.byteLength));
    offset = start + size + (size % 2);
  }
  if (![16_000, 24_000].includes(sampleRate) || channels !== 1 || bitsPerSample !== 16 || pcm.byteLength === 0) throw new Error(`Unsupported WAV: ${path}`);
  return { sampleRate, channels, bitsPerSample, pcm };
}

function resampleTo16k(wav: Wav): Uint8Array {
  if (wav.sampleRate === 16_000) return wav.pcm;
  const source = new DataView(wav.pcm.buffer, wav.pcm.byteOffset, wav.pcm.byteLength);
  const sourceSamples = wav.pcm.byteLength / 2;
  const targetSamples = Math.floor(sourceSamples * 16_000 / wav.sampleRate);
  const target = new Uint8Array(targetSamples * 2);
  const output = new DataView(target.buffer);
  for (let i = 0; i < targetSamples; i += 1) {
    const position = i * wav.sampleRate / 16_000;
    const leftIndex = Math.min(sourceSamples - 1, Math.floor(position));
    const rightIndex = Math.min(sourceSamples - 1, leftIndex + 1);
    const fraction = position - leftIndex;
    const left = source.getInt16(leftIndex * 2, true);
    const right = source.getInt16(rightIndex * 2, true);
    output.setInt16(i * 2, Math.round(left + (right - left) * fraction), true);
  }
  return target;
}

function rms(data: Uint8Array): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let sum = 0;
  for (let i = 0; i + 1 < data.byteLength; i += 2) {
    const sample = view.getInt16(i, true) / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / Math.max(1, data.byteLength / 2));
}

describe("Voice V3 raw Gemini pipeline with generated WAV input", () => {
  it("sends WAV frames through transport, adapter, orchestrator, and playback for T01-T05", async () => {
    const results: Array<Record<string, unknown>> = [];

    for (const file of FILES) {
      let now = 0;
      const server = new MockGeminiServer({ nowMono: () => now });
      const audio = new RawPipelineAudioContext();
      const app = new VoiceV3App({ providerMode: "mock", mockServer: server, nowMono: () => now, audioContextFactory: () => audio as unknown as AudioContext });
      const messages: string[] = [];
      const providerTypes: string[] = [];
      const unsubscribe = app.bus.subscribe((envelope) => {
        messages.push(envelope.messageType);
        if (envelope.messageType === "adapter.event") {
          const event = envelope.payload as { type?: string };
          if (event.type) providerTypes.push(event.type);
        }
      }, {});

      try {
        await app.start({ startCapture: false });
        const wav = await readWav(`${ROOT}/${file}`);
        const pcm = resampleTo16k(wav);
        const frameBytes = 640;
        const frameCount = Math.min(150, Math.floor(pcm.byteLength / frameBytes));
        expect(frameCount).toBe(150);

        for (let sequence = 0; sequence < frameCount; sequence += 1) {
          const frameData = pcm.slice(sequence * frameBytes, (sequence + 1) * frameBytes);
          now += 20;
          const accepted = app.transportManager.sendAudioFrame({
            frameId: `raw-wav-${file}-${sequence}`,
            sequence,
            sampleRate: 16_000,
            channels: 1,
            format: "pcm_s16le",
            data: frameData.buffer.slice(frameData.byteOffset, frameData.byteOffset + frameData.byteLength),
            capturedAtMono: now,
            durationMs: 20,
            muted: false,
            rms: rms(frameData),
          });
          expect(accepted).toBe(true);
        }

        await Promise.resolve();
        await Promise.resolve();
        server.simulateTurnComplete();
        await Promise.resolve();

        expect(server.receivedAudioFrames).toBe(150);
        expect(providerTypes).toContain("PROVIDER_INPUT_TRANSCRIPT");
        expect(providerTypes).toContain("PROVIDER_OUTPUT_TRANSCRIPT");
        expect(providerTypes).toContain("PROVIDER_AUDIO");
        expect(providerTypes).toContain("PROVIDER_TURN_COMPLETE");
        expect(messages).toContain("playback.chunk-scheduled");
        expect(audio.scheduledSources.length).toBeGreaterThan(0);
        expect(app.orchestrator.state).toBe("LISTENING");

        results.push({ file, sourceSampleRate: wav.sampleRate, captureSampleRate: 16_000, framesSent: app.transportManager.snapshot.framesSent, providerEvents: providerTypes.length, playbackSources: audio.scheduledSources.length, finalState: app.orchestrator.state });
      } finally {
        unsubscribe();
        app.dispose();
      }
    }

    expect(results).toHaveLength(5);
  }, 30_000);
});
