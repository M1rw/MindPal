/**
 * Drives a real `LiveVoiceSession` with scripted fakes and a virtual clock.
 *
 * Every outside dependency (Gemini socket, speaker, microphone, control plane,
 * page) is replaced by an object that records what the call did to it, so a
 * test reads like a call: "caller says no, 1.2s passes, MindPal answers".
 */
import { LiveVoiceSession } from '../../frontend/src/voice/call/callController.ts';

export const GRANT = {
  token: 'real-token',
  ws_url: 'wss://example.invalid/live',
  expires_at: new Date(Date.UTC(2030, 0, 1)).toISOString(),
  model: 'models/test-live',
  voice_id: 'Sulafat',
  session_id: 'vs_test',
  quota_remaining_s: 1800,
  session_limit_s: 1800,
  setup: { setup: { model: 'models/test-live' } },
  setup_timeout_ms: 12000,
};

/** A clock that only moves when the test says so. */
export class FakeClock {
  constructor(start = 1_000_000) {
    this.t = start;
    this.seq = 0;
    this.timers = new Map();
  }
  now() {
    return this.t;
  }
  setTimeout(fn, ms) {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn, every: 0 });
    return id;
  }
  clearTimeout(id) {
    this.timers.delete(id);
  }
  setInterval(fn, ms) {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn, every: ms });
    return id;
  }
  clearInterval(id) {
    this.timers.delete(id);
  }
  /** Run everything due within `ms`, in time order. */
  async advance(ms) {
    const end = this.t + ms;
    for (;;) {
      let nextId = null;
      let next = null;
      for (const [id, timer] of this.timers) {
        if (timer.at <= end && (!next || timer.at < next.at)) {
          next = timer;
          nextId = id;
        }
      }
      if (!next) break;
      this.t = next.at;
      if (next.every) next.at += next.every;
      else this.timers.delete(nextId);
      next.fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
}

export async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

/** 24kHz PCM, so 480 samples is 20ms of MindPal audio. */
export const CHUNK_MS = 20;
const CHUNK_SAMPLES = 480;

/** The speaker: audio is "playing" until its queued duration has elapsed. */
export class FakePlayback {
  constructor(clock, options) {
    this.clock = clock;
    this.options = options;
    this.gated = false;
    this.playingUntil = 0;
    this.flushes = 0;
    this.played = [];
    this.idleNotified = true;
    clock.setInterval(() => this.poll(), 10);
  }
  async ensure() {}
  enqueue(pcm) {
    if (this.gated) return false;
    const start = Math.max(this.playingUntil, this.clock.now());
    this.playingUntil = start + (pcm.length / CHUNK_SAMPLES) * CHUNK_MS;
    this.played.push(pcm.length);
    this.idleNotified = false;
    return true;
  }
  flush() {
    this.flushes += 1;
    this.gated = true;
    this.playingUntil = 0;
    this.poll();
    return 0;
  }
  releaseFence() {
    this.gated = false;
    return 0;
  }
  flushPrebuffer() {
    return true;
  }
  isPlaying() {
    return this.playingUntil > this.clock.now();
  }
  queuedMs() {
    return Math.max(0, this.playingUntil - this.clock.now());
  }
  poll() {
    if (!this.idleNotified && !this.isPlaying()) {
      this.idleNotified = true;
      this.options.onIdle();
    }
  }
  playedMs() {
    return 0;
  }
  lastEnvelope() {
    return 0;
  }
  jitterSnapshot() {
    return { targetMs: 70, underruns: 0, queuedSamples: 0, streaming: false };
  }
  async dispose() {
    this.playingUntil = 0;
  }
}

/** Gemini Live, scripted. */
export class FakeTransport {
  constructor(grant, handlers, options) {
    this.grant = grant;
    this.handlers = handlers;
    this.options = options;
    this.pcmSent = 0;
    this.notes = [];
    this.clientContent = [];
    this.toolResponses = [];
    this.openerRetries = 0;
    this.openingFinishedCalls = 0;
    this.closed = null;
  }
  connect() {
    this.connected = true;
  }
  async close(code = 1000, reason = '') {
    this.closed = { code, reason };
  }
  sendPcm16() {
    this.pcmSent += 1;
  }
  sendAudioStreamEnd() {
    this.streamEnds = (this.streamEnds || 0) + 1;
  }
  sendApplicationNote(text) {
    this.notes.push(text);
  }
  sendClientContent(text) {
    this.clientContent.push(text);
  }
  sendToolResponse(message) {
    this.toolResponses.push(message);
  }
  retryOpener() {
    this.openerRetries += 1;
    return true;
  }
  openingFinished() {
    this.openingFinishedCalls += 1;
  }
  uplink() {
    return { sent: this.pcmSent };
  }

  // --- things Gemini does
  setup() {
    this.handlers.onSetupComplete();
  }
  /** `ms` of MindPal audio, in 20ms chunks. */
  audio(ms) {
    for (let i = 0; i < Math.ceil(ms / CHUNK_MS); i += 1) this.handlers.onAudio(new Int16Array(CHUNK_SAMPLES));
  }
  modelText(text) {
    this.handlers.onOutputTranscript(text);
  }
  userText(text) {
    this.handlers.onInputTranscript(text, false);
  }
  interrupted() {
    this.handlers.onInterrupted();
  }
  generationComplete() {
    this.handlers.onGenerationComplete?.();
  }
  turnComplete() {
    this.handlers.onTurnComplete?.();
  }
  /** A whole spoken reply: text, audio, completion. */
  say(text, ms = 1000) {
    this.modelText(text);
    this.audio(ms);
    this.generationComplete();
    this.turnComplete();
  }
  tool(name, args) {
    this.handlers.onToolCalls?.([{ id: `call-${name}`, name, args }]);
  }
  goAway() {
    this.handlers.onGoAway?.();
  }
  drop(reason = 'provider_close') {
    this.handlers.onClose(1011, reason);
  }
}

export class FakeControl {
  constructor() {
    this.syncs = [];
    this.floors = [];
    this.verdicts = [];
    this.renewals = 0;
    this.teardowns = [];
    this.risks = [];
    this.sessionMissing = false;
  }
  async syncTranscripts(input, output, options) {
    this.syncs.push({ input, output, isFinal: Boolean(options?.isFinal) });
    return this.verdicts.shift() ?? { ok: true, action: 'continue', safety_verified: true };
  }
  async reportRisk(risk, kind, band, confirmations) {
    this.risks.push({ risk, kind, band, confirmations });
    return { ok: true, action: 'continue' };
  }
  async floor(from, to, reason) {
    this.floors.push({ from, to, reason });
    return { ok: true, action: 'continue' };
  }
  async warm() {
    return { ok: true, action: 'continue' };
  }
  async teardown(reason, usedS) {
    this.teardowns.push({ reason, usedS });
    return { ok: true, action: 'torn_down' };
  }
  async renew() {
    this.renewals += 1;
    return { ...GRANT, token: `renewed-${this.renewals}` };
  }
}

export class FakeMic {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.enabled = true;
    this.stopped = false;
  }
  setEnabled(enabled) {
    this.enabled = enabled;
  }
  resume() {}
  async stop() {
    this.stopped = true;
  }
  /** One 20ms frame at the given loudness. */
  frame(rms = 0.05) {
    this.onFrame(new Int16Array(320), rms);
  }
}

/** Everything the UI would see. */
function recorder() {
  const ui = {
    statuses: [],
    turns: [],
    inputCaption: '',
    outputCaption: '',
    thinking: [],
    floors: [],
    fallbacks: [],
    ended: null,
    trace: null,
    reactions: [],
    reactionTimes: [],
    looks: [],
    /** [time, expression] for every look shown, to check it against the audio. */
    lookTimes: [],
    /** Spoken-character progress of MindPal's reply, as the transcript last saw it. */
    spoken: null,
    /** The face's active expressions, as the renderer last saw them. */
    commands: [],
    /** [stage, secondsLeft] for every idle escalation the overlay was told about. */
    idle: [],
    muted: [],
  };
  const callbacks = {
    onStatus: (status, detail) => ui.statuses.push(detail ? `${status}:${detail}` : status),
    onEnergy: () => {},
    onFloor: (floor) => ui.floors.push(floor),
    onInputCaption: (text) => {
      ui.inputCaption = text;
    },
    onOutputCaption: (text) => {
      ui.outputCaption = text;
    },
    onTurn: (role, text) => ui.turns.push([role, text]),
    onThinking: (on) => ui.thinking.push(on),
    onFallback: (message) => ui.fallbacks.push(message),
    onIdle: (stage, secondsLeft) => ui.idle.push([stage, secondsLeft]),
    onMuted: (muted) => ui.muted.push(muted),
    onEnded: (receipt) => {
      ui.ended = receipt;
    },
    onTrace: (report) => {
      ui.trace = report;
    },
    onReaction: (reaction) => {
      ui.reactions.push(reaction.kind);
      ui.reactionTimes.push(reaction.at);
    },
    onCommands: (list) => {
      ui.commands = list;
    },
    onExpression: (command) => {
      if (!command) return;
      ui.looks.push(command.expression);
      ui.lookTimes.push([command.startedAt, command.expression]);
    },
    onOutputProgress: (chars) => {
      ui.spoken = chars;
    },
  };
  return { ui, callbacks };
}

/**
 * A call with every dependency faked. `start()` connects; `ready()` also
 * completes setup so the call is live.
 */
export function makeCall(options = {}) {
  const clock = new FakeClock();
  const control = new FakeControl();
  const transports = [];
  const mics = [];
  const pageHandlers = { hide: null, visible: null };
  let playback = null;
  const grant = { ...GRANT, ...(options.grant || {}) };
  const deps = {
    clock,
    page: {
      onHide: (fn) => {
        pageHandlers.hide = fn;
        return () => {};
      },
      onVisible: (fn) => {
        pageHandlers.visible = fn;
        return () => {};
      },
    },
    mint: options.mint || (async () => grant),
    clearStuckSession: async () => {},
    keepalive: () => {},
    control: () => control,
    transport: (g, handlers, opts) => {
      const transport = new FakeTransport(g, handlers, opts);
      transports.push(transport);
      return transport;
    },
    audioContext: () => ({ state: 'running', close: async () => {} }),
    playback: (opts) => {
      playback = new FakePlayback(clock, opts);
      return playback;
    },
    classifyReaction: options.classify,
    recall: options.recall,
    capture: async (onFrame) => {
      if (options.micError) throw options.micError;
      const mic = new FakeMic(onFrame);
      mics.push(mic);
      return mic;
    },
  };
  const { ui, callbacks } = recorder();
  const session = new LiveVoiceSession(callbacks, deps);
  if (options.profile) session.setOpenerProfile(options.profile);
  if (options.threadNote) session.setThreadNote(options.threadNote);

  const call = {
    session,
    clock,
    control,
    ui,
    pageHandlers,
    get transport() {
      return transports[transports.length - 1];
    },
    transports,
    get mic() {
      return mics[mics.length - 1];
    },
    get playback() {
      return playback;
    },
    get phase() {
      return session.currentPhase;
    },
    async start() {
      await session.start();
      await flush();
    },
    /** Connected, set up, and past a short greeting. */
    async ready({ greet = true } = {}) {
      await call.start();
      call.transport.setup();
      if (greet) {
        call.transport.say('Hey there, how are you?', 600);
        await clock.advance(700);
      }
    },
    advance: (ms) => clock.advance(ms),
    /** `ms` of the caller's voice at the mic, then `pauseMs` of silence. No words. */
    async voice(ms, pauseMs = 600) {
      for (let t = 0; t < ms; t += 20) {
        call.mic.frame(0.25);
        await clock.advance(20);
      }
      for (let t = 0; t < pauseMs; t += 20) {
        call.mic.frame(0);
        await clock.advance(20);
      }
    },
    /** The caller says something, word by word, 150ms apart. */
    async userSays(text) {
      for (const word of text.split(' ')) {
        call.transport.userText(` ${word}`);
        call.mic?.frame(0.2);
        await clock.advance(150);
      }
    },
  };
  return call;
}
