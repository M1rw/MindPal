import type { GeminiLiveHandlers, ParsedLiveMessage, VoiceLiveGrant } from '../types.ts';
import { parseFunctionCalls } from '../face/expressionCommand.ts';
import { applicationNoteMessage, situationNudgeMessage } from '../safety/crisisEnforcer.ts';

/** Drop newest capture frames when the socket is more than one ~200ms JSON+base64 burst behind. */
export const MAX_WS_BUFFERED_BYTES = 48_000;

function base64ToPcm16(value: string): Int16Array {
  const binary = atob(value);
  // Int16Array over an odd-length buffer throws. Provider PCM is always 16-bit,
  // but a truncated frame must drop one byte rather than kill the message.
  const usable = binary.length - (binary.length % 2);
  const bytes = new Uint8Array(usable);
  for (let i = 0; i < usable; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

function partText(part: Record<string, unknown>): string {
  if (part.thought === true) return '';
  const text = part.text;
  return typeof text === 'string' ? text : '';
}

export function liveErrorMessage(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const error = (raw as { error?: unknown }).error;
  if (!error) return null;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const status = record.status ?? record.code ?? 'ERROR';
    const text = typeof record.message === 'string' ? record.message.trim() : '';
    return text ? `Gemini ${status}: ${text}` : `Gemini ${status}`;
  }
  return null;
}

/** Provider content filter. Keep the socket; never map this to the pause wall. */
export function isProviderSafetyBlock(message: string): boolean {
  const text = message.toLowerCase();
  if (!text) return false;
  if (text.includes('blockedreason') || text.includes('block_reason') || text.includes('blockreason')) return true;
  if (text.includes('prohibited')) return true;
  if (text.includes('safety') && (text.includes('block') || text.includes('filter'))) {
    return true;
  }
  if (text.includes('blocked') && (text.includes('harm') || text.includes('content') || text.includes('policy'))) {
    return true;
  }
  return false;
}

export const GREETING_NUDGE = 'Hi.';
/**
 * The opener when the call continues an existing chat thread.
 *
 * The thread note itself is `realtimeInput.text` - context with no turn
 * boundary, so it never makes the model generate. Sent alone it produced a call
 * that connected and then sat in silence until the caller spoke first, which
 * read as MindPal being slow to say anything.
 *
 * Labeled so the base instruction treats it as an application note rather than
 * as the caller's words, the same convention as every other injected note.
 */
export const RESUME_NUDGE = [
  '[[MindPal]] Application note, not their words. Do not read this note aloud.',
  'The call just connected and it continues the text thread above.',
  'Open it yourself now, in one short sentence, picking up that thread.',
  'Do not greet as if you just met and do not summarise what was said.',
].join(' ');
/** Hold mic PCM after setup so room tone cannot barge the opening greeting. */
export const GREETING_HOLD_MS = 2500;
/**
 * Once the opener is audible, how long the hold may last while it plays.
 *
 * The opener is generated in about half a second but takes about three to play.
 * Releasing the microphone when generation finished opened it while MindPal was
 * still talking, the speaker bled into the mic, Gemini heard "speech" and cut
 * its own greeting off. The session ends the hold when playback actually goes
 * idle; this is only the ceiling if that signal never comes.
 */
export const OPENER_PLAYING_MAX_MS = 1_000;

export function playableAudioChunks(message: ParsedLiveMessage): Int16Array[] {
  if (message.interrupted) return [];
  return message.audioChunks;
}

/** User endpoint: inputFinished, never a model turnComplete that still has audio or captions. */
export function isUserTurnFinal(message: ParsedLiveMessage): boolean {
  if (message.inputFinished) return true;
  return Boolean(
    message.turnComplete && !message.audioChunks.length && !message.outputTranscript && message.inputTranscript,
  );
}

export function parseLiveMessage(raw: unknown): ParsedLiveMessage {
  const empty: ParsedLiveMessage = {
    setupComplete: false,
    interrupted: false,
    audioChunks: [],
    inputTranscript: '',
    outputTranscript: '',
    turnComplete: false,
    inputFinished: false,
    generationComplete: false,
    goAway: false,
    sessionResumptionHandle: '',
    toolCalls: [],
    error: null,
  };
  if (!raw || typeof raw !== 'object') return empty;
  const message = raw as Record<string, unknown>;
  empty.error = liveErrorMessage(message);
  if ('setupComplete' in message) {
    empty.setupComplete = true;
  }
  if ('goAway' in message) {
    empty.goAway = true;
  }
  const resumption = message.sessionResumptionUpdate ?? message.session_resumption_update;
  if (resumption && typeof resumption === 'object') {
    const record = resumption as { newHandle?: unknown; new_handle?: unknown };
    const handle = record.newHandle ?? record.new_handle;
    if (typeof handle === 'string' && handle.trim()) empty.sessionResumptionHandle = handle.trim();
  }
  empty.toolCalls = parseFunctionCalls(message.toolCall ?? message.tool_call);
  const serverContent = message.serverContent;
  if (!serverContent || typeof serverContent !== 'object') return empty;
  const content = serverContent as Record<string, unknown>;
  empty.interrupted = content.interrupted === true;
  empty.turnComplete = content.turnComplete === true;
  empty.generationComplete = content.generationComplete === true;
  const input = content.inputTranscription;
  if (input && typeof input === 'object') {
    const record = input as { text?: unknown; finished?: unknown };
    if (typeof record.text === 'string') empty.inputTranscript = record.text;
    empty.inputFinished = record.finished === true;
  }
  const output = content.outputTranscription;
  if (output && typeof output === 'object' && typeof (output as { text?: unknown }).text === 'string') {
    empty.outputTranscript = (output as { text: string }).text;
  }
  const modelTurn = content.modelTurn;
  if (modelTurn && typeof modelTurn === 'object') {
    const parts = (modelTurn as { parts?: unknown }).parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        const record = part as Record<string, unknown>;
        if (record.thought === true) continue;
        const inline = record.inlineData;
        if (inline && typeof inline === 'object') {
          const data = (inline as { data?: unknown }).data;
          if (typeof data === 'string' && data) {
            empty.audioChunks.push(base64ToPcm16(data));
          }
        }
        const text = partText(record);
        if (text) empty.outputTranscript += text;
      }
    }
  }
  return empty;
}

export class GeminiLiveAdapter {
  private socket: WebSocket | null = null;
  private setupTimer: number | null = null;
  private ready = false;
  private closed = false;
  private greeted = false;
  private skipGreeting = false;
  private continuation = '';
  private threadNote = '';
  private openingContext = '';
  private openerRetried = false;
  private captureHeld = false;
  /** Has the held-for generation actually produced audio yet? */
  private greetingAudioSeen = false;
  private greetingTimer: number | null = null;
  private droppedCaptureFrames = 0;
  private sentCaptureFrames = 0;
  private heldCaptureFrames = 0;
  private notReadyCaptureFrames = 0;
  private lastTrafficAt = 0;
  private grant: VoiceLiveGrant;
  private handlers: GeminiLiveHandlers;

  constructor(
    grant: VoiceLiveGrant,
    handlers: GeminiLiveHandlers,
    options?: { skipGreeting?: boolean; continuation?: string; threadNote?: string; openingContext?: string },
  ) {
    this.grant = grant;
    this.handlers = handlers;
    this.skipGreeting = options?.skipGreeting === true;
    this.continuation = (options?.continuation || '').trim();
    this.threadNote = (options?.threadNote || '').trim();
    this.openingContext = (options?.openingContext || '').trim();
    this.lastTrafficAt = Date.now();
  }

  /**
   * True while mic PCM is being withheld so the opener can be generated
   * without room tone barging it. Read by tests and by the trace.
   */
  get isCaptureHeld(): boolean {
    return this.captureHeld;
  }

  connect(): void {
    const socket = new WebSocket(this.grant.ws_url);
    this.socket = socket;
    this.lastTrafficAt = Date.now();
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify(this.grant.setup));
      const timeoutMs = this.grant.setup_timeout_ms || 12000;
      this.setupTimer = window.setTimeout(() => {
        if (this.ready || this.closed) return;
        this.handlers.onError('Live voice did not finish connecting. Falling back to dictation.');
        console.info('[mindpal.voice] handshake_fail', { reason: 'setup_timeout', timeout_ms: timeoutMs });
        void this.close(4000, 'setup_timeout');
      }, timeoutMs);
    });
    socket.addEventListener('message', (event) => {
      this.lastTrafficAt = Date.now();
      void this.handleMessage(event.data);
    });
    socket.addEventListener('error', () => {
      if (!this.closed) {
        this.handlers.onError('The live voice connection failed.');
      }
    });
    socket.addEventListener('close', (event) => {
      this.clearTimer();
      if (this.closed) return;
      this.closed = true;
      this.handlers.onClose(event.code, event.reason || 'closed');
    });
  }

  /** Upstream counters, so a silent stall can be told apart from a silent room. */
  uplink(): { sent: number; dropped: number; heldByGreeting: number; notReady: number; bufferedBytes: number; quietMs: number } {
    return {
      sent: this.sentCaptureFrames,
      dropped: this.droppedCaptureFrames,
      heldByGreeting: this.heldCaptureFrames,
      notReady: this.notReadyCaptureFrames,
      bufferedBytes: this.socket?.bufferedAmount ?? 0,
      quietMs: this.lastTrafficAt ? Math.max(0, Date.now() - this.lastTrafficAt) : 0,
    };
  }

  /** True when capture has sent sustained audio but provider has been completely silent > 20s. */
  isStalled(now = Date.now()): boolean {
    if (!this.ready || this.closed || this.captureHeld) return false;
    if (this.sentCaptureFrames < 100) return false;
    return now - this.lastTrafficAt >= 20_000;
  }

  sendPcm16(pcm: Int16Array): void {
    if (this.captureHeld) {
      this.heldCaptureFrames += 1;
      return;
    }
    if (!this.ready || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.notReadyCaptureFrames += 1;
      return;
    }
    if (this.socket.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
      this.droppedCaptureFrames += 1;
      if (this.droppedCaptureFrames === 1 || this.droppedCaptureFrames % 50 === 0) {
        console.info('[mindpal.voice] ws_buffered_bytes', {
          bufferedAmount: this.socket.bufferedAmount,
          droppedCaptureFrames: this.droppedCaptureFrames,
        });
      }
      return;
    }
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    this.sentCaptureFrames += 1;
    this.socket.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            data: btoa(binary),
            mimeType: 'audio/pcm;rate=16000',
          },
        },
      }),
    );
  }

  sendToolResponse(message: Record<string, unknown>): void {
    if (!this.ready || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  /**
   * Mid-session stay-with-you refresh. The constrained Live socket has no
   * systemInstruction rewrite, so this is a labeled application note the base
   * instruction already treats as not the caller's words.
   */
  /**
   * Context the model should know without it being a turn.
   *
   * Use sparingly: to Gemini Live this is caller input, and it interrupts any
   * reply in progress. Topic cards and clock notes sent through here killed the
   * first reply after almost every turn. Reserved for safety notes, which are
   * meant to cut in.
   */
  sendApplicationNote(text: string): void {
    const note = text.trim();
    if (!note || !this.ready || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(applicationNoteMessage(note)));
  }

  /**
   * Force a model turn with a labeled situation nudge. Constrained Live has no
   * mid-call systemInstruction rewrite; this is the backup so they hear a reply
   * before the overlay pause.
   */
  sendClientContent(text: string): void {
    const note = text.trim();
    if (!note || !this.ready || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(situationNudgeMessage(note)));
  }

  async close(code = 1000, reason = 'client_hangup'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    this.releaseGreetingHold();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      try {
        socket.close(code, reason.slice(0, 123));
      } catch {
        /* already closing */
      }
    }
  }

  private async handleMessage(data: unknown): Promise<void> {
    // Called as `void this.handleMessage(...)`, so anything thrown here becomes an
    // unhandled rejection: the frame vanishes with no error surfaced anywhere.
    // Blob/ArrayBuffer parsing and base64 PCM decoding can both throw on a
    // malformed frame, so the whole body is guarded.
    try {
      await this.dispatchMessage(data);
    } catch (error) {
      console.info('[mindpal.voice] live_message_dropped', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async dispatchMessage(data: unknown): Promise<void> {
    let parsed: unknown = data;
    if (typeof data === 'string') {
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
    } else if (data instanceof Blob) {
      parsed = JSON.parse(await data.text());
    } else if (data instanceof ArrayBuffer) {
      parsed = JSON.parse(new TextDecoder().decode(data));
    }
    const message = parseLiveMessage(parsed);
    if (message.error) {
      if (isProviderSafetyBlock(message.error)) {
        console.info('[mindpal.voice] provider_safety_block', { message: message.error });
        return;
      }
      this.handlers.onError(message.error);
      void this.close(4000, 'provider_error');
      return;
    }
    if (message.setupComplete && !this.ready) {
      this.armGreetingHold();
      this.ready = true;
      this.clearTimer();
      this.handlers.onSetupComplete();
      // One message opens the call. The thread and the clock used to go out as
      // separate `realtimeInput` notes first, and Gemini treats realtimeInput
      // as the caller speaking: a trace shows `provider_interrupted` 75ms after
      // setup and a greeting that came back with zero characters.
      if (this.continuation) this.seedContinuation(this.continuation);
      else this.nudgeGreeting();
    }
    if (message.goAway) {
      this.handlers.onGoAway?.();
    }
    if (message.sessionResumptionHandle) {
      this.handlers.onSessionResumption?.(message.sessionResumptionHandle);
    }
    if (message.interrupted) {
      // An `interrupted` before the opener has made a sound is not an
      // interruption of anything. Releasing the hold there opens the microphone
      // into a generation that has not started, and the room then kills it: one
      // trace shows the hold lasting 4 frames instead of 125, the opener coming
      // back with zero characters, and the caller waiting 11 seconds for a hello
      // that only arrived because the reply watchdog rescued it.
      // While the opener's hold is up the caller's microphone is not being
      // sent, so an `interrupted` here is the room or MindPal's own echo, never
      // the caller. It does not end the hold.
      this.handlers.onInterrupted();
    }
    for (const chunk of playableAudioChunks(message)) {
      if (this.captureHeld && !this.greetingAudioSeen) {
        // First sound of the opener: keep holding until it has finished playing.
        this.greetingAudioSeen = true;
        if (this.greetingTimer !== null) window.clearTimeout(this.greetingTimer);
        this.greetingTimer = window.setTimeout(() => this.releaseGreetingHold(), OPENER_PLAYING_MAX_MS);
      }
      this.handlers.onAudio(chunk);
    }
    if (message.inputTranscript) {
      this.handlers.onInputTranscript(message.inputTranscript, isUserTurnFinal(message));
    }
    if (message.outputTranscript) {
      this.handlers.onOutputTranscript(message.outputTranscript);
    }
    if (message.generationComplete) {
      this.handlers.onGenerationComplete?.();
    }
    if (message.turnComplete) {
      this.handlers.onTurnComplete?.();
    }
    if (message.toolCalls.length) {
      this.handlers.onToolCalls?.(message.toolCalls);
    }
  }

  private seedContinuation(text: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.greeted = true;
    this.sendClientContent(text);
  }

  /**
   * Make the model open the call. With a thread note in context the opener is
   * about that thread; from cold it is a plain hello. `skipGreeting` suppresses
   * only the cold one, because a resumed call still has to say something.
   */
  /**
   * Send the opener once more. The session calls this when the first one came
   * back empty, which otherwise leaves the caller in silence at the start of
   * the call with nothing to answer.
   */
  retryOpener(): boolean {
    if (this.openerRetried || !this.ready || this.continuation) return false;
    this.openerRetried = true;
    this.greeted = false;
    this.armGreetingHold();
    this.nudgeGreeting();
    return this.greeted;
  }

  private nudgeGreeting(): void {
    if (this.greeted || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (this.skipGreeting && !this.threadNote) return;
    this.greeted = true;
    const opener = this.threadNote ? RESUME_NUDGE : GREETING_NUDGE;
    this.sendClientContent([this.openingContext, this.threadNote, opener].filter(Boolean).join('\n'));
  }

  private armGreetingHold(): void {
    // Whenever an opener is coming, room tone must not barge it. Previously a
    // resumed call armed nothing, so the first noise after connect produced an
    // `interrupt_ignored / nothing was playing` before a word was spoken.
    if (this.skipGreeting && !this.continuation && !this.threadNote) return;
    this.captureHeld = true;
    this.greetingAudioSeen = false;
    if (this.greetingTimer !== null) window.clearTimeout(this.greetingTimer);
    this.greetingTimer = window.setTimeout(() => this.releaseGreetingHold(), GREETING_HOLD_MS);
  }

  /**
   * The session saw the opener finish playing. Open the microphone.
   *
   * Only meaningful once the opener has been heard: a playback-idle before the
   * first sample is just the quiet before the greeting arrives.
   */
  openingFinished(): void {
    if (!this.captureHeld || !this.greetingAudioSeen) return;
    this.releaseGreetingHold();
  }

  /** Open the microphone again. The timers and `openingFinished` are the only callers. */
  private releaseGreetingHold(): void {
    this.captureHeld = false;
    this.greetingAudioSeen = false;
    if (this.greetingTimer !== null) {
      window.clearTimeout(this.greetingTimer);
      this.greetingTimer = null;
    }
  }

  private clearTimer(): void {
    if (this.setupTimer !== null) {
      window.clearTimeout(this.setupTimer);
      this.setupTimer = null;
    }
  }
}
