/**
 * One live voice call.
 *
 * Gemini Live runs the conversation: its voice activity detection decides when
 * the caller starts and stops, and it reports barge-in as `interrupted`. This
 * controller moves audio in and out, turns Gemini's events into call state
 * (`callMachine`), and hands the pieces that need memory to small modules:
 * the transcript, the reply guard, the safety bridge and the face feed.
 */
import { SpeechTimeline } from './speechTimeline.ts';
import { describeMicFailure } from '../audio/micErrors.ts';
import { isProviderSafetyBlock } from '../control/geminiLive.ts';
import { downloadTrace, VoiceTrace, type VoiceTraceReport } from '../diagnostics/trace.ts';
import { functionResponseMessage, type LiveFunctionCall } from '../face/expressionCommand.ts';
import { STAY_SUPPORT_NOTE } from '../safety/crisisEnforcer.ts';
import { openerNote, type OpenerProfile } from '../session/opener.ts';
import type { FloorState, LiveUiStatus, VoiceLiveGrant } from '../types.ts';
import { ApiError } from '../../services/api/http.ts';
import { classifyVoiceError } from '../../services/api/voice.ts';
import type { LiveCallReceipt, LiveSessionCallbacks } from './callTypes.ts';
import { isLive, transition, type CallEffect, type CallEvent, type CallPhase } from './callMachine.ts';
import {
  browserDeps,
  isRecallTool,
  type CallDeps,
  type ControlPort,
  type MicPort,
  type PlaybackPort,
  type TransportOptions,
  type TransportPort,
} from './deps.ts';
import { FaceFeed } from './faceFeed.ts';
import { NamedTimers, renewDelayMs, rollingContinuation, rotateDelayMs, usableSuccessor } from './lifecycle.ts';
import { REPLY_NUDGE_NOTE, ReplyGuard } from './replyGuard.ts';
import { SafetyBridge, type SafetyOutcome } from './safetyBridge.ts';
import { CallTranscript } from './transcript.ts';
import { holdScreenAwake } from '../../utils/mobile/wakeLock.ts';
import { IdleWatch, idleNote } from './idle.ts';

/** How often the controller checks its clocks (pause, reply guard, heartbeat). */
export const TICK_MS = 250;
/**
 * The speech clock: releases scheduled face looks and advances the spoken part
 * of the caption. Separate from TICK_MS because mic frames, which used to drive
 * both, stop when the caller mutes, and 250ms is a visible stutter on a caption.
 */
export const SPEECH_TICK_MS = 80;
/** Gemini Live speaks 16-bit mono PCM at 24kHz. */
const MODEL_AUDIO_RATE = 24_000;
/** No new caller words for this long closes their turn on screen and for safety. */
export const USER_PAUSE_MS = 1_200;
/** After a barge-in, audio still in flight from the cut reply is dropped for this long. */
export const BARGE_IN_FENCE_MS = 450;
/** Consecutive 20ms capture frames needed before locally yielding the floor. */
const LOCAL_BARGE_IN_FRAMES = 2;
/** Ignore very quiet room tone while MindPal is speaking. */
const LOCAL_BARGE_IN_RMS = 0.055;
/** Prevent a local cut and a delayed provider event from causing a second cut. */
const LOCAL_BARGE_IN_COOLDOWN_MS = 350;
/** A greeting normally starts ~3s after setup. Past this, ask for it once more. */
export const OPENER_SILENT_MS = 7_000;
const QUIET_WAIT_MS = 1_600;
/** What the model hears when a lookup fails: never silence, which would stall its turn. */
export const RECALL_UNAVAILABLE = 'Nothing relevant found. Do not guess or invent what they said before.';

const SESSION_ENDED = 'The live call ended. You can start another call or use text.';
const SESSION_LIMIT_ENDED = 'This live call reached its 30-minute limit. You can start another call or use text.';
const PROVIDER_CONTINUATION =
  'The speech provider is starting a continuation of this call. Recent words are passed along; the live session itself is new.';
const MIC_LOST = 'Microphone disconnected. Plug it back in or use dictation.';
const SESSION_MISSING =
  'The live voice session ended on the server. Start a new call, or use dictation in the composer.';

function floorOf(phase: CallPhase): FloorState {
  if (phase === 'speaking') return 'speaking';
  return isLive(phase) ? 'listening' : 'idle';
}

function isStuckActiveSession(error: unknown): boolean {
  if (error instanceof ApiError && error.code === 'conflict') return true;
  const message = error instanceof Error ? error.message : String(error || '');
  return /already in progress on this account/i.test(message);
}

export class LiveVoiceSession {
  readonly trace = new VoiceTrace();
  private readonly deps: CallDeps;
  private readonly callbacks: LiveSessionCallbacks;
  private readonly timers: NamedTimers;
  private readonly transcript = new CallTranscript();
  private readonly guard = new ReplyGuard();
  private readonly face: FaceFeed;
  private readonly playback: PlaybackPort;

  private phase: CallPhase = 'idle';
  private floor: FloorState = 'idle';
  private status: LiveUiStatus | null = null;
  private grant: VoiceLiveGrant | null = null;
  private successor: VoiceLiveGrant | null = null;
  private control: ControlPort | null = null;
  private safety: SafetyBridge | null = null;
  private transport: TransportPort | null = null;
  private mic: MicPort | null = null;
  private context: AudioContext | null = null;
  private ticker: unknown = null;
  private speechTicker: unknown = null;
  /** MindPal's live caption on its audio, so the UI can show what has been heard. */
  private readonly captionTimeline = new SpeechTimeline();
  private captionChars = 0;
  /** The turn was committed to history but may still be playing. */
  private captionCommitted = false;
  private lastSpoken = -1;
  private unbindPage: Array<() => void> = [];

  private epoch = 0;
  private startedAt = 0;
  private setupStartedAt = 0;
  private setupAt = 0;
  private warmed = false;
  private reconnectAttempted = false;
  /** A socket swap is in progress; its own close events are expected. */
  private replacing = false;
  private providerRotated = false;
  private resumptionHandle = '';
  private micRetried = false;
  private muted = false;
  private closed = false;
  private failing = false;
  private endedNotified = false;
  private openerHeard = false;
  private openerRetried = false;
  private openerFinished = false;
  private modelStreaming = false;
  private audioResumePending = false;
  private lastUserWordsAt = 0;
  private fenceUntil = 0;
  /** Bumped on every barge-in: Gemini discards pending tool calls when interrupted. */
  private interruptions = 0;
  private lastInterruptedAt = 0;
  private lastInterruptedSaid = '';
  private localBargeFrames = 0;
  private lastLocalBargeAt = 0;
  private replyRequestedAt = 0;
  private pendingNotes: string[] = [];
  private readonly idle = new IdleWatch();
  /** Set when the idle goodbye was asked for; the call ends once it has been said. */
  private idleEndingAt = 0;
  private threadNote = '';
  private openerProfile: OpenerProfile = {};

  constructor(callbacks: LiveSessionCallbacks, deps: CallDeps = browserDeps()) {
    this.callbacks = callbacks;
    this.deps = deps;
    this.timers = new NamedTimers(deps.clock);
    this.face = new FaceFeed(callbacks, { classify: deps.classifyReaction, now: () => deps.clock.now() });
    this.playback = deps.playback({
      onIdle: () => this.onPlaybackIdle(),
      onTone: (tone) => callbacks.onPlaybackEnergy?.(tone.envelope, tone.brightness),
      onEvent: (event, data) => this.trace.add('playback', event, data),
    });
  }

  // ---------------------------------------------------------------- public

  setThreadNote(text: string): void {
    this.threadNote = (text || '').trim();
  }

  /** Who is calling, so the opener can greet them rather than a stranger. */
  setOpenerProfile(profile: OpenerProfile): void {
    this.openerProfile = profile;
  }

  setMuted(muted: boolean): void {
    const was = this.muted;
    this.muted = muted;
    this.mic?.setEnabled(!muted);
    if (muted === was) return;
    this.trace.add('mic', muted ? 'muted' : 'unmuted', {});
    // Muting mid-sentence used to leave the turn open forever: Gemini waits for
    // silence it never receives. Ending the stream makes it answer what was said.
    if (muted) this.transport?.sendAudioStreamEnd?.();
    this.idle.noteMuted(muted, this.now());
    this.callbacks.onMuted?.(muted);
  }

  setReducedMotion(reduced: boolean): void {
    this.face.setReducedMotion(reduced);
  }

  get isStayingForSupport(): boolean {
    return this.safety?.supporting ?? false;
  }

  get currentPhase(): CallPhase {
    return this.phase;
  }

  async start(): Promise<void> {
    this.closed = false;
    this.trace.add('session', 'start_clicked');
    this.startedAt = this.now();
    this.dispatch({ type: 'connect' });
    this.setStatus('connecting');
    // Built inside the click so the autoplay gesture is fresh; overlaps the mint.
    const audioReady = this.prepareAudio();

    let grant: VoiceLiveGrant;
    try {
      grant = await this.mintWithRecovery();
    } catch (error) {
      const message = classifyVoiceError(error).message;
      this.setStatus('unavailable', message);
      this.callbacks.onFallback(message);
      await this.abandonStart(audioReady);
      return;
    }
    if (this.closed) return this.abandonStart(audioReady);
    if (!grant.token || grant.token.startsWith('vt_') || !grant.ws_url) {
      this.setStatus('error', 'Live voice did not receive a real session token.');
      this.callbacks.onFallback('Live voice did not receive a real session token. Use dictation instead.');
      return this.abandonStart(audioReady);
    }
    this.trace.add('mint', 'ok', {
      ms: this.now() - this.startedAt,
      model: grant.model,
      voiceId: grant.voice_id,
      sessionLimitS: grant.session_limit_s,
      quotaRemainingS: grant.quota_remaining_s,
      safetySettingsApplied: grant.safety_settings_applied,
      proactivityApplied: grant.proactivity_applied,
      resumptionApplied: grant.session_resumption_applied,
      models: grant.models,
    });
    this.grant = grant;
    this.callbacks.onVoiceId?.(grant.voice_id);
    this.callbacks.onQuota?.(grant.session_limit_s || 0, grant.quota_remaining_s);
    this.control = this.deps.control(grant.session_id, this.trace);
    this.safety = new SafetyBridge(this.control, this.trace, this.now(), grant.safety_heartbeat_ms);
    this.bindPage();
    this.armTimers(grant);
    this.ticker = this.deps.clock.setInterval(() => this.tick(), TICK_MS);
    this.speechTicker = this.deps.clock.setInterval(() => this.speechTick(), SPEECH_TICK_MS);

    const context = await audioReady;
    if (!context) {
      await this.fail('Live playback could not start. You can still dictate into the composer.');
      return;
    }
    if (this.closed) return;
    this.trace.add('audio', 'ready', { msAfterClick: this.now() - this.startedAt });
    this.attach(grant, {
      skipGreeting: Boolean(this.threadNote),
      threadNote: this.threadNote || undefined,
      openingContext: openerNote(this.openerProfile, new Date(this.now())),
    });
    try {
      this.mic = await this.openMic(context);
    } catch (error) {
      await this.micFailed(error, 'capture_failed');
    }
  }

  async hangup(reason = 'client_hangup'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.trace.add('session', 'hangup', { reason });
    const usedS = this.usedS();
    const receipt: LiveCallReceipt = {
      sessionId: this.grant?.session_id || '',
      inputTranscript: this.transcript.userText,
      outputTranscript: [this.transcript.modelText, this.transcript.currentModel].filter(Boolean).join(' '),
      reason,
      crisis: this.isStayingForSupport,
      usedS,
    };
    if (this.ticker !== null) this.deps.clock.clearInterval(this.ticker);
    this.ticker = null;
    if (this.speechTicker !== null) this.deps.clock.clearInterval(this.speechTicker);
    this.speechTicker = null;
    this.timers.clearAll();
    this.unbindPage.forEach((unbind) => unbind());
    this.unbindPage = [];
    this.dispatch({ type: 'end' });
    this.epoch += 1;
    await this.transport?.close(1000, reason);
    this.transport = null;
    await this.playback.dispose();
    await this.mic?.stop().catch(() => {});
    this.mic = null;
    if (this.context && this.context.state !== 'closed') await this.context.close().catch(() => {});
    this.context = null;
    await this.control?.teardown(reason, usedS).catch(() => null);
    // Built before the grant is dropped, so it still names the model and voice.
    const report = this.traceReport(reason);
    this.control = null;
    this.grant = null;
    this.successor = null;
    this.face.reset();
    this.callbacks.onTrace?.(report);
    if (!this.endedNotified) {
      this.endedNotified = true;
      await this.callbacks.onEnded?.(receipt);
    }
  }

  /** The whole call as one JSON object: timeline plus derived findings. */
  traceReport(reason = 'manual'): VoiceTraceReport {
    const models = this.grant?.models;
    return this.trace.report({
      reason,
      sessionId: this.grant?.session_id || '',
      models: {
        live: models?.live || this.grant?.model || '',
        liveVoice: models?.live_voice || this.grant?.voice_id || '',
        chatProvider: models?.chat_provider || '',
        chatModel: models?.chat_model || '',
        classifierProvider: models?.classifier_provider || '',
        classifierModel: models?.classifier_model || '',
        classifierMode: models?.classifier_mode || '',
      },
      model: this.grant?.model || '',
      voiceId: this.grant?.voice_id || '',
      elapsedS: this.usedS(),
      phase: this.phase,
      muted: this.muted,
      crisis: { supporting: this.isStayingForSupport, peakRisk: this.safety?.peakRisk ?? 0 },
      playback: this.playback.jitterSnapshot(),
      transcripts: { user: this.transcript.userText, model: this.transcript.modelText },
    });
  }

  downloadTraceReport(reason = 'manual'): boolean {
    return downloadTrace(this.traceReport(reason));
  }

  // ---------------------------------------------------------------- state

  private dispatch(event: CallEvent): void {
    const from = this.phase;
    const next = transition(from, event);
    this.phase = next.phase;
    for (const effect of next.effects) this.apply(effect);
    if (next.phase !== from) this.phaseChanged(event.type);
  }

  private apply(effect: CallEffect): void {
    const now = this.now();
    if (effect === 'commitUser') {
      const text = this.transcript.takeUserTurn();
      if (!text) return;
      this.trace.add('vad', 'user_final', { text, phase: this.phase });
      this.callbacks.onTurn?.('user', text);
      this.callbacks.onInputCaption('');
      void this.syncSafety(true);
    } else if (effect === 'thinkingOn') {
      this.guard.userTurnEnded(now);
      this.replyRequestedAt = now;
      this.trace.add('audio', 'reply_wait_start', { phase: this.phase });
      this.callbacks.onThinking?.(true);
      this.face.setThinking(true);
    } else if (effect === 'thinkingOff') {
      this.guard.settle();
      this.callbacks.onThinking?.(false);
      this.face.setThinking(false);
    } else if (effect === 'flushPlayback') {
      const playedMs = this.playback.flush();
      this.trace.add('interrupt', 'playback_flushed', {
        latencyMs: this.lastInterruptedAt > 0 ? now - this.lastInterruptedAt : null,
        playedMs,
      });
      this.face.stopSpeaking();
      this.clearSpokenProgress();
      this.fenceUntil = now + BARGE_IN_FENCE_MS;
      this.modelStreaming = false;
      if (this.replyRequestedAt > 0) {
        this.trace.add('audio', 'reply_wait_cancelled', {
          waitedMs: now - this.replyRequestedAt,
          reason: 'barge_in',
        });
        this.replyRequestedAt = 0;
      }
      // Whatever MindPal got out before being cut is part of the conversation.
      this.commitModelTurn();
      // The pause clock starts now, so a cough that interrupts settles back to listening.
      this.lastUserWordsAt = now;
    }
  }

  private phaseChanged(reason: string): void {
    const floor = floorOf(this.phase);
    if (floor !== this.floor) {
      const from = this.floor;
      this.floor = floor;
      this.trace.add('floor', 'transition', { from, to: floor, reason, playedMs: this.playback.playedMs() });
      void this.control?.floor(from, floor, reason, this.playback.playedMs()).catch(() => null);
      this.callbacks.onFloor?.(floor);
    }
    this.syncStatus();
    if (this.phase === 'listening') this.flushNotes();
  }

  private syncStatus(): void {
    // A reconnect keeps showing the call as it was; it is usually over in a second.
    if (this.phase === 'reconnecting' || this.phase === 'ended' || this.failing) return;
    if (this.phase === 'connecting' || this.phase === 'idle') return this.setStatus('connecting');
    if (this.phase === 'speaking') return this.setStatus('speaking');
    this.setStatus(this.isStayingForSupport ? 'stay_support' : 'listening');
  }

  private setStatus(status: LiveUiStatus, detail?: string): void {
    if (status === this.status && !detail) return;
    this.status = status;
    this.callbacks.onStatus(status, detail);
  }

  // ---------------------------------------------------------------- audio in

  private onMicFrame(pcm: Int16Array, rms: number): void {
    const now = this.now();
    this.face.micFrame(pcm, rms, {
      floor: this.floor,
      transcript: this.transcript.currentUser,
      // Its own audio still playing is MindPal speaking, whatever the phase
      // machine says (an echo can move the phase before playback drains).
      modelSpeaking: this.phase === 'speaking' || this.playback.isPlaying(),
      playbackEnergy: this.playback.lastEnvelope(),
      now,
    });
    if (this.muted || !this.transport) return;
    this.resumeAudioIfNeeded('capture_frame');
    if (this.phase === 'speaking') {
      if (rms >= LOCAL_BARGE_IN_RMS) {
        this.localBargeFrames += 1;
        if (
          this.localBargeFrames >= LOCAL_BARGE_IN_FRAMES &&
          now - this.lastLocalBargeAt >= LOCAL_BARGE_IN_COOLDOWN_MS
        ) {
          this.lastLocalBargeAt = now;
          this.localBargeFrames = 0;
          this.lastInterruptedAt = now;
          this.lastInterruptedSaid = this.transcript.currentModel;
          this.trace.add('interrupt', 'decision', {
            kind: 'barge_in',
            flush: true,
            reason: 'local_speech_onset',
            rms,
            queuedMs: this.playback.queuedMs(),
          });
          this.interruptions += 1;
          this.dispatch({ type: 'interrupted' });
        }
      } else {
        this.localBargeFrames = 0;
      }
    } else {
      this.localBargeFrames = 0;
    }
    // Allow caller to interrupt opening greeting:
    // If MindPal's opener is playing and the caller speaks with voice energy, release the greeting hold
    // immediately so caller audio streams to Gemini and triggers barge-in!
    if (this.openerHeard && !this.openerFinished && this.phase === 'speaking') {
      if (rms >= 0.035) {
        this.openerFinished = true;
        this.transport.openingFinished();
      }
    }
    this.trace.noteMicFrame(false, () => this.transport?.uplink());
    this.transport.sendPcm16(pcm);
  }

  private async openMic(context: AudioContext): Promise<MicPort> {
    const mic = await this.deps.capture((pcm, rms) => this.onMicFrame(pcm, rms), {
      context,
      onDeviceLost: () => void this.recoverMic(),
    });
    mic.setEnabled(!this.muted);
    return mic;
  }

  private async recoverMic(): Promise<void> {
    if (this.closed || this.failing) return;
    if (this.micRetried || !this.context) {
      await this.fail(MIC_LOST, 'device_lost');
      return;
    }
    this.micRetried = true;
    await this.mic?.stop().catch(() => {});
    try {
      this.mic = await this.openMic(this.context);
    } catch (error) {
      await this.micFailed(error, 'recover_failed');
    }
  }

  private async micFailed(error: unknown, event: string): Promise<void> {
    // Say which failure this was: a busy or missing device is not a permission problem.
    const failure = describeMicFailure(error);
    const cause = error instanceof Error ? error.message : String(error);
    this.trace.add('mic', event, { reason: failure.reason, name: failure.name, detail: cause.slice(0, 160) });
    console.info('[mindpal.voice] mic_capture_failed', { reason: failure.reason, name: failure.name, cause });
    await this.fail(failure.message, `mic_${failure.reason}`);
  }

  // ---------------------------------------------------------------- provider

  private attach(grant: VoiceLiveGrant, options: TransportOptions): void {
    const epoch = ++this.epoch;
    const current = () => epoch === this.epoch && !this.closed;
    this.setupStartedAt = this.now();
    this.transport = this.deps.transport(
      grant,
      {
        onSetupComplete: () => current() && this.onSetup(epoch),
        onAudio: (pcm) => current() && this.onModelAudio(pcm),
        onInterrupted: () => current() && this.onInterrupted(),
        onInputTranscript: (text) => current() && this.onUserText(text),
        onOutputTranscript: (text) => current() && this.onModelText(text),
        onGenerationComplete: () => current() && this.onGenerationComplete(),
        onTurnComplete: () => current() && this.onTurnComplete(),
        onToolCalls: (calls) => current() && this.onToolCalls(calls),
        onGoAway: () => {
          if (!current()) return;
          this.trace.add('socket', 'go_away');
          void this.reconnect('provider_goaway');
        },
        onSessionResumption: (handle) => {
          if (current()) this.resumptionHandle = handle;
        },
        onError: (message) => {
          if (!current()) return;
          this.trace.add('error', 'provider', { message: message.slice(0, 200) });
          if (isProviderSafetyBlock(message)) return;
          void this.fail(message, 'provider_error');
        },
        onClose: (code, reason) => {
          this.trace.add('socket', 'close', { code, reason, epoch, stale: !current() });
          if (current()) this.onSocketClosed(reason);
        },
      },
      options,
    );
    this.transport.connect();
  }

  private onSetup(epoch: number): void {
    const tSetupMs = this.now() - this.setupStartedAt;
    this.trace.add('setup', 'complete', { tSetupMs, epoch });
    if (!this.warmed) void this.control?.warm(tSetupMs).catch(() => null);
    this.warmed = true;
    // A connection that reached setup is healthy: the next drop may reconnect again.
    this.reconnectAttempted = false;
    this.setupAt = this.now();
    this.dispatch({ type: 'ready' });
  }

  private onModelAudio(pcm: Int16Array): void {
    const now = this.now();
    if (this.fenceUntil) {
      // Leftover audio of the reply the caller just cut off.
      if (now < this.fenceUntil) return;
      this.releaseFence();
    }
    if (!this.playback.enqueue(pcm)) return;
    const audioMs = (pcm.length / MODEL_AUDIO_RATE) * 1000;
    const queuedMs = this.playback.queuedMs();
    this.face.modelAudio(audioMs, now, queuedMs);
    if (this.captionCommitted) this.resetCaptionTimeline();
    this.captionTimeline.audio(audioMs, now, queuedMs);
    this.modelStreaming = true;
    this.openerHeard = true;
    this.transcript.noteModelAudio();
    this.guard.settle();
    this.face.setThinking(false);
    this.trace.noteModelAudio(pcm.length);
    if (this.replyRequestedAt > 0) {
      this.trace.add('audio', 'first_audio', {
        latencyMs: now - this.replyRequestedAt,
        queuedMs: this.playback.queuedMs(),
      });
      this.replyRequestedAt = 0;
    }
    this.dispatch({ type: 'modelAudio' });
  }

  private onInterrupted(): void {
    this.trace.add('interrupt', 'provider_interrupted', { phase: this.phase });
    if (this.phase !== 'speaking' && !this.playback.isPlaying()) {
      this.trace.add('interrupt', 'nothing_to_interrupt', { phase: this.phase });
      return;
    }
    this.lastInterruptedAt = this.now();
    this.lastInterruptedSaid = this.transcript.currentModel;
    this.trace.add('interrupt', 'decision', { kind: 'barge_in', flush: true, reason: 'provider' });
    this.interruptions += 1;
    this.dispatch({ type: 'interrupted' });
  }

  private onUserText(raw: string): void {
    const caption = this.transcript.userDelta(raw);
    if (caption === null) {
      this.trace.add('caption', 'user_noise_only', { delta: raw.slice(0, 40) });
      return;
    }
    const now = this.now();
    this.lastUserWordsAt = now;
    this.noteCallerActivity(now);
    this.trace.add('caption', 'user', { text: caption, delta: raw });
    this.callbacks.onInputCaption(caption);
    this.face.userWords(raw, now);
    this.dispatch({ type: 'userWords' });
  }

  private onModelText(raw: string): void {
    const { caption, hasWords } = this.transcript.modelDelta(raw);
    this.modelStreaming = true;
    this.guard.generationDelta(this.now(), hasWords);
    const now = this.now();
    this.face.modelWords(raw, now, this.playback.queuedMs());
    this.trackCaption(caption);
    this.trace.add('caption', 'model', { text: caption, delta: raw });
    if (caption) this.callbacks.onOutputCaption(caption);
  }

  private onGenerationComplete(): void {
    const now = this.now();
    this.trace.flushAudioRun();
    const heard = this.transcript.modelWasHeard;
    const text = this.transcript.currentModel;
    this.trace.add('audio', 'generation_complete', { chars: text.length });
    if (this.guard.owed && !heard && !text) this.trace.add('audio', 'empty_generation', {});
    this.guard.generationComplete(now);
    if (!heard && text) this.trace.add('audio', 'unspoken_generation', { chars: text.length, text: text.slice(0, 60) });
    // The greeting came back empty: without a retry the caller sits in silence.
    if (!heard && !this.openerHeard) this.retryOpener('empty_opener');
    this.face.modelTurnEnded(now, this.playback.queuedMs());
    this.commitModelTurn();
    this.playback.flushPrebuffer();
    this.endModelStream();
  }

  private onTurnComplete(): void {
    this.trace.add('audio', 'turn_complete');
    if (this.fenceUntil) this.releaseFence();
    this.endModelStream();
  }

  private onToolCalls(all: LiveFunctionCall[]): void {
    const now = this.now();
    this.trace.add('tool', 'calls', { names: all.map((call) => call.name) });
    // Lookups go to the backend and answer later; everything else answers now.
    for (const call of all.filter((c) => isRecallTool(c.name))) void this.recall(call);
    const calls = all.filter((c) => !isRecallTool(c.name));
    if (!calls.length) return;
    const applied = calls.map((call) => {
      const face = this.face.tool(call.name, call.args, now, this.playback.queuedMs());
      if (face !== null) return face;
      if (call.name !== 'report_risk' || !this.safety) return false;
      const { handled, outcome } = this.safety.riskTool(call.args, now);
      this.applySafety(outcome);
      return handled;
    });
    this.transport?.sendToolResponse(functionResponseMessage(calls, applied));
  }

  /**
   * A memory or past-chat lookup the model asked for. The eyes read back while it
   * runs; the answer goes back WHEN_IDLE so MindPal finishes its sentence first.
   */
  private async recall(call: LiveFunctionCall): Promise<void> {
    const sessionId = this.grant?.session_id;
    const tool = call.name;
    if (!isRecallTool(tool)) return;
    const query = typeof call.args.query === 'string' ? call.args.query : '';
    const epoch = this.epoch;
    const interruptions = this.interruptions;
    const startedAt = this.now();
    this.face.noteLookup(1);
    let result = RECALL_UNAVAILABLE;
    let found = false;
    try {
      if (sessionId && this.deps.recall) {
        const answer = await this.deps.recall(sessionId, tool, query);
        result = answer.result || RECALL_UNAVAILABLE;
        found = answer.found;
      }
    } catch {
      /* the model still gets an answer below */
    } finally {
      this.face.noteLookup(-1);
    }
    this.trace.add('tool', 'recall', { tool, found, ms: this.now() - startedAt, chars: result.length });
    // A new socket, a hangup, or a barge-in (Gemini drops pending calls) makes this stale.
    if (this.closed || epoch !== this.epoch) return;
    if (interruptions !== this.interruptions) {
      if (found && result !== RECALL_UNAVAILABLE) {
        this.trace.add('tool', 'recall_interrupted_cached', { tool, query: query.slice(0, 50) });
        this.pendingNotes.push(`[[MindPal]] Context from recent memory lookup for "${query}": ${result}`);
      }
      return;
    }
    this.transport?.sendToolResponse({
      toolResponse: {
        functionResponses: [{ id: call.id, name: tool, response: { result, scheduling: 'WHEN_IDLE' } }],
      },
    });
  }

  private commitModelTurn(): void {
    const said = this.transcript.takeModelTurn();
    if (said) this.callbacks.onTurn?.('model', said);
    this.callbacks.onOutputCaption('');
    // Generation ends seconds before playback does. The committed turn keeps
    // its timeline so the UI can go on showing which of its words are heard.
    if (said) this.captionCommitted = true;
    else this.clearSpokenProgress();
  }

  private endModelStream(): void {
    this.modelStreaming = false;
    if (!this.playback.isPlaying()) this.onPlaybackIdle();
  }

  private onPlaybackIdle(): void {
    // The ring drains between provider bursts; the turn is only over when the
    // provider has also stopped sending.
    if (this.modelStreaming || this.closed) return;
    if (this.openerHeard && !this.openerFinished) {
      this.openerFinished = true;
      this.transport?.openingFinished();
    }
    const wasSpeaking = this.phase === 'speaking';
    this.clearSpokenProgress();
    this.dispatch({ type: 'playbackIdle' });
    if (wasSpeaking && this.phase === 'listening') this.face.speechEnded();
    // Words said over MindPal that did not interrupt it still form a turn.
    if (this.phase === 'listening' && this.transcript.currentUser) this.dispatch({ type: 'userWords' });
  }

  private releaseFence(): void {
    this.fenceUntil = 0;
    this.playback.releaseFence();
  }

  private retryOpener(reason: 'empty_opener' | 'silent_opener'): void {
    if (this.openerHeard || this.openerRetried || this.transcript.currentUser) return;
    this.openerRetried = true;
    const sent = this.transport?.retryOpener() ?? false;
    this.trace.add('audio', 'opener_retry', { reason, sent });
  }

  // ---------------------------------------------------------------- clock

  private speechTick(): void {
    if (this.closed) return;
    const now = this.now();
    this.face.tick(now);
    if (!this.captionTimeline.length) return;
    const spoken = this.captionTimeline.spokenChars(now);
    if (spoken === this.lastSpoken) return;
    this.lastSpoken = spoken;
    this.callbacks.onOutputProgress?.(spoken);
  }

  private trackCaption(caption: string): void {
    // First words of the next reply: the previous one's timeline is done.
    if (this.captionCommitted) this.resetCaptionTimeline();
    const added = caption.length - this.captionChars;
    if (added <= 0) return;
    this.captionTimeline.text(added);
    this.captionChars = caption.length;
  }

  private resetCaptionTimeline(): void {
    this.captionTimeline.reset();
    this.captionChars = 0;
    this.captionCommitted = false;
    this.lastSpoken = -1;
  }

  private clearSpokenProgress(): void {
    const had = this.captionTimeline.length > 0;
    this.captionTimeline.reset();
    this.captionChars = 0;
    this.captionCommitted = false;
    this.lastSpoken = -1;
    if (had) this.callbacks.onOutputProgress?.(null);
  }

  private tick(): void {
    if (this.closed) return;
    const now = this.now();
    if (this.phase === 'userSpeaking' && now - this.lastUserWordsAt >= USER_PAUSE_MS) {
      const spoke = Boolean(this.transcript.currentUser);
      if (!spoke && this.lastInterruptedAt > 0) {
        this.trace.add('interrupt', 'spurious_barge_in', { cutChars: this.lastInterruptedSaid.length });
        this.lastInterruptedAt = 0;
      }
      this.dispatch({ type: 'userPaused', spoke });
    }
    const nudge = this.guard.poll(now);
    if (nudge && this.phase === 'waitingReply') {
      this.trace.add('vad', 'reply_nudge', { why: nudge });
      console.info('[mindpal.voice] reply_nudge', { why: nudge });
      this.transport?.sendClientContent(REPLY_NUDGE_NOTE);
    }
    if (this.fenceUntil && now >= this.fenceUntil) this.releaseFence();
    this.face.tick(now);
    if (!this.openerHeard && this.setupAt && now - this.setupAt >= OPENER_SILENT_MS) this.retryOpener('silent_opener');
    if (this.safety?.heartbeatDue(now)) void this.syncSafety(false);
    this.pollIdle(now);
    if (this.warmed && !this.closed && !this.failing && !this.replacing && !this.reconnectAttempted && this.transport?.isStalled?.(now)) {
      this.trace.add('socket', 'asr_stall_reconnect', { quietMs: this.transport.uplink?.()?.quietMs ?? 0 });
      void this.reconnect('asr_stall_timeout');
    }
    this.flushNotes();
  }

  // ---------------------------------------------------------------- safety

  private async syncSafety(isFinal: boolean): Promise<void> {
    const safety = this.safety;
    if (!safety || this.closed || this.failing) return;
    const outcome = await safety.sync(this.transcript.safetyWindow(), this.transcript.recentModel(), isFinal, this.now());
    if (this.closed) return;
    this.applySafety(outcome);
    // A live mental-health call with no safety path is not a call to keep open.
    if (safety.sessionMissing) {
      this.trace.add('control', 'session_missing_hangup', {});
      await this.fail(SESSION_MISSING, 'session_missing');
    }
  }

  private applySafety(outcome: SafetyOutcome | null): void {
    if (!outcome) return;
    this.face.support(this.now());
    this.syncStatus();
    // Imminent risk cuts in now; a support note waits so it shapes the next
    // reply instead of killing the current one.
    if (outcome.urgent) this.transport?.sendApplicationNote(outcome.note);
    else this.pendingNotes.push(outcome.note);
    this.flushNotes();
  }

  /** "I'm here" in the call overlay, or anything else that proves they're present. */
  stillHere(): void {
    this.noteCallerActivity(this.now());
  }

  private noteCallerActivity(now: number): void {
    const wasIdle = this.idle.current !== 'active';
    this.idle.activity(now);
    if (this.idleEndingAt) {
      // They came back during the goodbye: keep the call.
      this.idleEndingAt = 0;
      this.timers.clear('idleEnd');
    }
    if (wasIdle) this.callbacks.onIdle?.('active', null);
  }

  private pollIdle(now: number): void {
    if (!this.warmed || this.closed || this.failing) return;
    const busy =
      this.phase !== 'listening' ||
      this.modelStreaming ||
      this.playback.isPlaying() ||
      this.replacing ||
      // Never time out someone MindPal is staying with through a crisis.
      this.isStayingForSupport;
    if (this.idleEndingAt) {
      // The goodbye has been said once the model has spoken and gone quiet again.
      if (!busy && now - this.idleEndingAt >= 2_500) void this.hangup('idle');
      return;
    }
    const step = this.idle.poll(now, busy);
    if (step) {
      this.trace.add('session', `idle_${step}`, { muted: this.idle.isMuted });
      console.info('[mindpal.voice] idle', { step, muted: this.idle.isMuted });
      this.transport?.sendClientContent(idleNote(step, this.idle.isMuted));
      if (step === 'end') {
        this.idleEndingAt = now;
        // If the goodbye never arrives, don't hold a silent line open.
        this.timers.set('idleEnd', 12_000, () => void this.hangup('idle'));
      }
    }
    if (step || this.idle.current === 'warn') {
      const left = this.idle.remainingMs(now);
      this.callbacks.onIdle?.(this.idle.current, left === null ? null : Math.ceil(left / 1000));
    }
  }

  private flushNotes(): void {
    if (!this.pendingNotes.length || !this.transport) return;
    if (this.phase !== 'listening' || this.modelStreaming || this.playback.isPlaying()) return;
    const notes = this.pendingNotes.splice(0);
    this.trace.add('tool', 'notes_flushed', { count: notes.length });
    this.transport.sendApplicationNote(notes.join('\n'));
  }

  // ---------------------------------------------------------------- lifetime

  private armTimers(grant: VoiceLiveGrant): void {
    if (grant.session_limit_s) {
      this.timers.set('limit', Math.max(30, grant.session_limit_s) * 1000, () => {
        void this.fail(SESSION_LIMIT_ENDED, 'session_limit');
      });
    }
    this.armRenew(grant);
    const rotateIn = rotateDelayMs(grant.provider_rotate_s, this.startedAt, this.now());
    if (rotateIn !== null) this.timers.set('rotate', rotateIn, () => void this.rotateProvider());
  }

  private armRenew(grant: VoiceLiveGrant): void {
    const wait = renewDelayMs(grant.expires_at, this.now());
    if (wait === null) return;
    this.timers.set('renew', wait, () => void this.warmSuccessor());
  }

  private async warmSuccessor(): Promise<void> {
    if (this.closed || this.failing || !this.control) return;
    try {
      const next = await this.control.renew(this.resumptionHandle || undefined);
      if (!this.closed && next.token) this.successor = next;
    } catch {
      /* keep the current socket; an unexpected close still reconnects once */
    }
  }

  private onSocketClosed(reason: string): void {
    if (this.closed || this.failing || this.replacing) return;
    if (this.warmed && !this.reconnectAttempted) {
      void this.reconnect(reason || 'provider_close');
      return;
    }
    void this.fail(SESSION_ENDED, reason || 'provider_close');
  }

  private async reconnect(reason: string): Promise<void> {
    if (this.closed || this.failing || this.replacing || this.reconnectAttempted) return;
    this.reconnectAttempted = true;
    try {
      await this.replaceSocket(reason, this.continuationNote());
    } catch {
      await this.fail(SESSION_ENDED, reason || 'reconnect_failed');
    }
  }

  private async rotateProvider(): Promise<void> {
    if (this.closed || this.failing || this.providerRotated || this.reconnectAttempted) return;
    this.providerRotated = true;
    try {
      await this.replaceSocket('provider_limit', this.continuationNote());
    } catch {
      await this.fail(PROVIDER_CONTINUATION, 'provider_limit');
    }
  }

  private continuationNote(): string {
    const recent = rollingContinuation(
      this.transcript.userText,
      [this.transcript.modelText, this.transcript.currentModel].filter(Boolean).join(' '),
    );
    return this.isStayingForSupport ? [recent, STAY_SUPPORT_NOTE].filter(Boolean).join('\n') : recent;
  }

  private async replaceSocket(closeReason: string, continuation: string): Promise<void> {
    this.replacing = true;
    try {
      await this.swapSocket(closeReason, continuation);
    } finally {
      this.replacing = false;
    }
  }

  private async swapSocket(closeReason: string, continuation: string): Promise<void> {
    await this.waitUntilQuiet();
    if (this.closed || this.failing) return;
    this.dispatch({ type: 'dropped' });
    let next = usableSuccessor(this.successor, this.now());
    this.successor = null;
    if (!next) {
      if (!this.control) throw new Error(SESSION_ENDED);
      next = await this.control.renew(this.resumptionHandle || undefined);
    }
    if (!next?.token || !next.ws_url) throw new Error(SESSION_ENDED);
    const previousGrant = this.grant;
    this.grant = { ...previousGrant, ...next, session_id: previousGrant?.session_id || next.session_id };
    this.callbacks.onVoiceId?.(next.voice_id);
    this.callbacks.onQuota?.(next.session_limit_s || this.grant.session_limit_s || 0, next.quota_remaining_s);
    const previous = this.transport;
    this.transport = null;
    this.epoch += 1;
    await previous?.close(1000, closeReason);
    if (this.closed || this.failing) return;
    this.armRenew(this.grant);
    const setup = next.setup?.setup as Record<string, unknown> | undefined;
    const resumed = Boolean(this.resumptionHandle && setup && 'sessionResumption' in setup);
    this.trace.add('socket', 'replaced', { reason: closeReason, resumed });
    this.attach(this.grant, { skipGreeting: true, continuation: resumed ? undefined : continuation || undefined });
  }

  private async waitUntilQuiet(): Promise<void> {
    const started = this.now();
    while (this.phase === 'speaking' && this.playback.isPlaying() && this.now() - started < QUIET_WAIT_MS) {
      await new Promise<void>((resolve) => this.deps.clock.setTimeout(resolve, 80));
    }
  }

  private bindPage(): void {
    const page = this.deps.page;
    if (!page) return;
    // A call is hands-free: without this the phone locks mid-sentence.
    this.unbindPage.push(holdScreenAwake());
    this.unbindPage.push(
      page.onVisible(() => {
        this.trace.add('session', 'page_visible');
        this.resumeAudioIfNeeded('page_visible');
        void this.playback.ensure();
        this.mic?.resume();
        this.mic?.setEnabled(!this.muted);
      }),
      page.onHide(() => {
        if (this.closed) return;
        this.deps.keepalive('pagehide', this.usedS(), this.grant?.session_id);
        void this.hangup('pagehide');
      }),
    );
  }

  private async mintWithRecovery(): Promise<VoiceLiveGrant> {
    try {
      return await this.deps.mint();
    } catch (error) {
      // Older servers refused a second mint; clear the stuck row and retry once.
      if (!isStuckActiveSession(error)) throw error;
      await this.deps.clearStuckSession();
      return this.deps.mint();
    }
  }

  private async prepareAudio(): Promise<AudioContext | null> {
    try {
      const context = this.deps.audioContext();
      this.context = context;
      await this.playback.ensure(context);
      return context;
    } catch {
      return null;
    }
  }

  private resumeAudioIfNeeded(reason: string): void {
    const context = this.context;
    if (!context || context.state !== 'suspended' || this.audioResumePending || this.closed) return;
    this.audioResumePending = true;
    this.trace.add('audio', 'resume_requested', { reason });
    void context.resume()
      .then(() => this.trace.add('audio', 'resume_complete', { reason }))
      .catch((error) => {
        this.trace.add('audio', 'resume_failed', {
          reason,
          message: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
        });
      })
      .finally(() => {
        this.audioResumePending = false;
      });
  }

  private async abandonStart(audioReady: Promise<AudioContext | null>): Promise<void> {
    const context = await audioReady.catch(() => null);
    this.dispatch({ type: 'end' });
    if (context && this.context === context) this.context = null;
    await context?.close().catch(() => {});
  }

  private async fail(message: string, reason = 'setup_failed'): Promise<void> {
    if (this.closed || this.failing) return;
    this.failing = true;
    this.status = 'error';
    this.callbacks.onStatus('error', message);
    this.callbacks.onFallback(message);
    await this.hangup(reason);
  }

  private usedS(): number {
    return this.startedAt ? Math.max(0, Math.round((this.now() - this.startedAt) / 1000)) : 0;
  }

  private now(): number {
    return this.deps.clock.now();
  }
}

export type { LiveCallReceipt, LiveSessionCallbacks } from './callTypes.ts';
