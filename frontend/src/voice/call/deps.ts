/**
 * The outside world a call talks to, as narrow ports.
 *
 * The controller only ever sees these interfaces. The browser build wires the
 * real WebSocket, AudioContext, microphone and HTTP client in `browserDeps`;
 * tests wire scripted fakes and a virtual clock, and drive whole calls.
 */
import { startPcmCapture } from '../audio/capture.ts';
import { PlaybackQueue, type PlaybackTone } from '../audio/playback.ts';
import {
  ControlPlaneClient,
  mintLiveGrant,
  teardownActiveSession,
  teardownKeepalive,
} from '../control/controlPlane.ts';
import { GeminiLiveAdapter } from '../control/geminiLive.ts';
import { voiceApi } from '../../services/api/voice.ts';
import type { VoiceTrace } from '../diagnostics/trace.ts';
import type { ControlPlaneAction, FloorState, GeminiLiveHandlers, VoiceLiveGrant } from '../types.ts';
import type { SafetyControl } from './safetyBridge.ts';
import { browserPage, realClock, type Clock, type PageHooks } from './lifecycle.ts';

/** Lookups the live model can ask for; the backend runs them. */
export const RECALL_TOOLS = ['search_memory', 'search_past_chats', 'search_library'] as const;
export type RecallTool = (typeof RECALL_TOOLS)[number];

export function isRecallTool(name: string): name is RecallTool {
  return (RECALL_TOOLS as readonly string[]).includes(name);
}

export interface ControlPort extends SafetyControl {
  floor(from: FloorState, to: FloorState, reason: string, playedMs?: number): Promise<ControlPlaneAction>;
  warm(tSetupMs: number): Promise<ControlPlaneAction>;
  teardown(reason: string, usedS: number): Promise<ControlPlaneAction>;
  renew(resumptionHandle?: string): Promise<VoiceLiveGrant>;
}

export interface TransportOptions {
  skipGreeting?: boolean;
  continuation?: string;
  threadNote?: string;
  openingContext?: string;
}

export interface TransportPort {
  connect(): void;
  close(code?: number, reason?: string): Promise<void>;
  sendPcm16(pcm: Int16Array): void;
  /**
   * The caller stopped sending audio (mute). Gemini closes a turn only after it
   * has received ~1.5 s of silence; when audio simply stops, the last words are
   * never answered. This tells it the stream ended so it replies now.
   */
  sendAudioStreamEnd?(): void;
  /** Context for the model. To Gemini this is caller input: it cuts a reply in progress. */
  sendApplicationNote(text: string): void;
  /** A labeled note that forces a model turn. */
  sendClientContent(text: string): void;
  sendToolResponse(message: Record<string, unknown>): void;
  retryOpener(): boolean;
  openingFinished(): void;
  uplink(): Record<string, number>;
  isStalled?(now?: number): boolean;
}

export interface PlaybackPort {
  ensure(shared?: AudioContext): Promise<unknown>;
  enqueue(pcm: Int16Array): boolean;
  flush(): number;
  releaseFence(): number;
  flushPrebuffer(): boolean;
  isPlaying(): boolean;
  /** Audio queued but not yet heard, in ms. */
  queuedMs(): number;
  playedMs(): number;
  lastEnvelope(): number;
  jitterSnapshot(): { targetMs: number; underruns: number; queuedSamples: number; streaming: boolean };
  dispose(): Promise<void>;
}

export interface PlaybackOptions {
  onIdle: () => void;
  onTone: (tone: PlaybackTone) => void;
  onEvent: (event: string, data?: Record<string, unknown>) => void;
}

export interface MicPort {
  setEnabled(enabled: boolean): void;
  resume(): void;
  stop(): Promise<void>;
}

export interface CallDeps {
  clock: Clock;
  page: PageHooks | null;
  mint(): Promise<VoiceLiveGrant>;
  /** Clear a stuck server-side session left by an earlier call. */
  clearStuckSession(): Promise<void>;
  /** Best-effort hangup that survives the page unloading. */
  keepalive(reason: string, usedS: number, sessionId?: string): void;
  control(sessionId: string, trace: VoiceTrace): ControlPort;
  transport(grant: VoiceLiveGrant, handlers: GeminiLiveHandlers, options: TransportOptions): TransportPort;
  audioContext(): AudioContext;
  playback(options: PlaybackOptions): PlaybackPort;
  capture(
    onFrame: (pcm: Int16Array, rms: number) => void,
    options: { context: AudioContext; onDeviceLost: () => void },
  ): Promise<MicPort>;
  /** Memory or past-chat lookup for the live model, answered by the backend. */
  recall?(sessionId: string, tool: RecallTool, query: string): Promise<{ result: string; found: boolean }>;
  /** What a phrase means to the listening face. Optional: without it the face only nods. */
  classifyReaction?(text: string, context: string, speaker?: 'caller' | 'mindpal'): Promise<string>;
}

export function browserDeps(): CallDeps {
  return {
    clock: realClock,
    page: browserPage,
    mint: mintLiveGrant,
    clearStuckSession: async () => {
      await teardownActiveSession('client_recover');
    },
    keepalive: (reason, usedS, sessionId) => teardownKeepalive(reason, usedS, sessionId),
    control: (sessionId, trace) => new ControlPlaneClient(sessionId, trace),
    transport: (grant, handlers, options) => new GeminiLiveAdapter(grant, handlers, options),
    audioContext: () => new AudioContext({ latencyHint: 'interactive' }),
    recall: (sessionId, tool, query) => voiceApi.recall(sessionId, tool, query),
    classifyReaction: async (text, context, speaker) =>
      (await voiceApi.classifyReaction(text, context, speaker)).reaction,
    playback: (options) => new PlaybackQueue(options),
    capture: async (onFrame, options) => {
      const handle = await startPcmCapture(onFrame, options);
      return {
        // `enabled = false` silences the track but keeps the device open, so
        // unmuting is instant and needs no second permission prompt.
        setEnabled: (enabled) => {
          handle.stream.getAudioTracks().forEach((track) => {
            track.enabled = enabled;
          });
        },
        resume: () => {
          if (handle.context.state === 'suspended') void handle.context.resume();
        },
        stop: () => handle.stop(),
      };
    },
  };
}
