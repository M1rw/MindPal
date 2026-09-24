/**
 * Everything the orb face reacts to, and nothing else.
 *
 * Fed microphone frames and words; emits energy, prosody, affect, visual
 * backchannels (nods) and expressions. Output only: nothing here can send to
 * the model, gate the microphone, or change the call. The old session let face
 * heuristics steer turn-taking, which is how a visual "join in" cue ended up
 * pushing MindPal to talk over people.
 */
import { AffectModel, type AffectLevels } from '../face/affect.ts';
import {
  createBackchannelMemory,
  evaluateBackchannel,
  transitionRelevance,
  type VisualBackchannel,
} from '../face/backchannel.ts';
import { DistressLatch } from '../face/distress.ts';
import { EnergyNormalizer, EnvelopeFollower } from '../face/energy.ts';
import {
  commandFromToolArgs,
  commandFromUserRequest,
  ExpressionDirector,
  moodFromToolArgs,
  type ActiveExpression,
} from '../face/expressionCommand.ts';
import {
  kindFor,
  ListenerReactor,
  PhraseDetector,
  reactionLook,
  type ListenerReaction,
  type ReactionKind,
} from '../face/listenerReaction.ts';
import { ProsodyTracker, type ProsodySnapshot } from '../face/prosody.ts';
import { mergeLiveTranscript } from '../session/caption.ts';
import { SpeechTimeline } from './speechTimeline.ts';
import type { FloorState } from '../types.ts';

const EMIT_EVERY_MS = 50;
/** Normalized frame level above which a 20ms frame counts as voice, for phrase timing. */
export const PHRASE_VOICED_LEVEL = 0.06;
const SAME_REQUEST_MS = 1_400;
/** Words since the last meaning check before asking again. */
export const MEANING_MIN_WORDS = 3;
/** At most one meaning check this often, and never two in flight. */
export const MEANING_GAP_MS = 1_500;

export interface FaceCallbacks {
  onEnergy: (rms: number) => void;
  onProsody?: (snapshot: ProsodySnapshot) => void;
  onAffect?: (levels: AffectLevels) => void;
  onDistress?: (active: boolean) => void;
  onBackchannel?: (event: VisualBackchannel | null, engagement: number) => void;
  onExpression?: (command: ActiveExpression | null) => void;
  onCommands?: (commands: ActiveExpression[]) => void;
  /** A listening reaction: nod, double nod, "ah", smile, curious tilt, concern. */
  onReaction?: (reaction: ListenerReaction) => void;
}

/** What a phrase means to the face, in any language. `mindpal`: its own sentence. */
export type ClassifyReaction = (text: string, context: string, speaker?: 'caller' | 'mindpal') => Promise<string>;

/**
 * Sentence ends, in scripts with and without spaces. Punctuation, not words: the
 * transcriber adds it in every language it writes.
 */
const SENTENCE_END = /(?:[.!?…؟]+["'”’)\]]*\s+)|(?:[。！？]+)/gu;

/** A tone look lasts its sentence, but a few looks read oddly held that long. */
const SPEECH_LOOK_MAX_MS: Partial<Record<ReactionKind, number>> = { ah: 1_800, laugh: 3_000, excited: 2_500 };
const SPEECH_LOOK_MIN_MS = 1_200;
const SPEECH_LOOK_CEILING_MS = 12_000;
/** A state holds until the call moves on; this only bounds a state nobody ended. */
const STATE_HOLD_MS = 20_000;
/**
 * Sentence tone checks in flight at once. One at a time put every look behind
 * the previous round trip, so on a long reply they fell further and further
 * behind the voice until the end.
 */
export const SPEECH_CLASSIFY_PARALLEL = 3;
/**
 * Minimum gap between starting two sentence checks. The server admits one
 * speaking-face check per 0.15s per account (more under load) and answered the
 * rest "none", so three sent at once came back as one look and two blanks.
 */
export const SPEECH_CLASSIFY_GAP_MS = 250;
/** The server's explicit "not admitted, try later" answer. */
export const THROTTLED = 'throttled';
/** A look that would show for less than this of its sentence is dropped, not shown late. */
const SPEECH_LOOK_STALE_MS = 250;

export type FaceState = 'thinking' | 'reading';

interface ScheduledLook {
  /** Timing is filled in when it is shown, from the timeline as it stands then. */
  command: Omit<ActiveExpression, 'startedAt' | 'durationMs'>;
  /** Its sentence, in characters of MindPal's reply. */
  fromChar: number;
  toChar: number;
  /** Longest it may hold, whatever the sentence's length. */
  capMs: number;
  /** Head motion that goes with it (a laugh's bounce), started with the look. */
  reaction: Omit<ListenerReaction, 'at'> | null;
}

interface SpokenSentence {
  text: string;
  fromChar: number;
  toChar: number;
  /** Already sent back once after a throttled answer. */
  retried?: boolean;
}

export interface FaceFeedOptions {
  classify?: ClassifyReaction;
  now?: () => number;
}

export interface FrameContext {
  floor: FloorState;
  transcript: string;
  modelSpeaking: boolean;
  playbackEnergy: number;
  now: number;
}

export class FaceFeed {
  private readonly energy = new EnergyNormalizer();
  private readonly envelope = new EnvelopeFollower(0.42, 0.16);
  private readonly prosody = new ProsodyTracker();
  private readonly affect = new AffectModel();
  private readonly distress = new DistressLatch();
  private readonly expressions = new ExpressionDirector();
  private readonly reactor = new ListenerReactor();
  private readonly phrases = new PhraseDetector();
  private readonly classify: ClassifyReaction | null;
  private readonly clock: () => number;
  private listening = false;
  /** Counts MindPal speaking turns; a listening reaction from before one is stale. */
  private speakingTurns = 0;
  /** Caller words not yet classified. Its own buffer: the transcript commits turns on its own clock. */
  private unread = '';
  /** The last classified phrase, as context for the next. */
  private lastPhrase = '';
  private meaningInFlight = false;
  private lastMeaningAt = Number.NEGATIVE_INFINITY;
  /** MindPal's words not yet split into sentences. */
  private speech = '';
  /** Where `speech` begins on the timeline, in characters. */
  private speechBase = 0;
  private readonly timeline = new SpeechTimeline();
  private sentences: SpokenSentence[] = [];
  private speechInFlight = 0;
  private lastSpeechCheckAt = Number.NEGATIVE_INFINITY;
  /** Bumped when MindPal is cut off, so late answers for its old sentences are dropped. */
  private speechEpoch = 0;
  /** Expressions waiting for their sentence's audio to play. */
  private scheduled: ScheduledLook[] = [];
  /** The tone of MindPal's last classified sentence, carried through neutral ones. */
  private speechTone: ReactionKind | null = null;
  private thinking = false;
  private lookups = 0;
  private shownState: FaceState | null = null;
  private backchannelMem = createBackchannelMemory();
  private distressShown = false;
  private lastEmitAt = 0;
  private lastRequest = '';
  private lastRequestAt = 0;
  private reducedMotion = false;
  private readonly callbacks: FaceCallbacks;

  constructor(callbacks: FaceCallbacks, options: FaceFeedOptions = {}) {
    this.callbacks = callbacks;
    this.classify = options.classify ?? null;
    this.clock = options.now ?? (() => Date.now());
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
  }

  /** One 20ms microphone frame. */
  micFrame(pcm: Int16Array, rms: number, context: FrameContext): void {
    const { now } = context;
    this.tick(now);
    const level = this.energy.push(rms);
    const scaled = this.envelope.push(level, 20);
    this.callbacks.onEnergy(scaled);
    const snapshot = this.prosody.push(pcm, scaled, now);
    this.distress.noteProsody(snapshot, now);
    const distressed = this.syncDistress(now);

    const decision = evaluateBackchannel(
      {
        floor: context.floor,
        turnMs: snapshot.turnMs,
        transcript: context.transcript,
        prosody: snapshot,
        distress: distressed,
        modelSpeaking: context.modelSpeaking,
        audibleEnabled: false,
        reducedMotion: this.reducedMotion,
        userEnergy: scaled,
        trp: transitionRelevance(snapshot, context.transcript),
        now,
      },
      this.backchannelMem,
    );
    if (decision.visual || decision.engagement) {
      this.callbacks.onBackchannel?.(decision.visual, decision.engagement);
    }
    // Phrase timing reads the raw frame level: the smoothed envelope stays "voiced"
    // ~300ms after speech stops, which hid every ordinary breath between phrases.
    this.listen(level > PHRASE_VOICED_LEVEL, context, distressed);

    if (now - this.lastEmitAt < EMIT_EVERY_MS) return;
    const dtMs = this.lastEmitAt ? now - this.lastEmitAt : EMIT_EVERY_MS;
    this.lastEmitAt = now;
    this.callbacks.onProsody?.(snapshot);
    this.callbacks.onAffect?.(
      this.affect.tick({
        prosody: snapshot,
        playbackEnergy: context.playbackEnergy,
        userEnergy: scaled,
        distress: distressed,
        dtMs,
      }),
    );
  }

  /** Caller words: distress cues, "wink at me" style requests, and text for the listening face. */
  userWords(delta: string, now: number): void {
    this.unread = mergeLiveTranscript(this.unread, delta).slice(-600);
    this.distress.noteText(delta, now);
    this.syncDistress(now);
    const command = commandFromUserRequest(delta, now);
    if (!command) return;
    if (command.expression === this.lastRequest && now - this.lastRequestAt < SAME_REQUEST_MS) return;
    this.lastRequest = command.expression;
    this.lastRequestAt = now;
    this.show(command);
  }

  /**
   * MindPal's own words as they stream in. Each finished sentence is read for its
   * tone and the matching look is placed on the audio timeline, from the moment
   * its first word is heard to the moment its last one is.
   */
  modelWords(delta: string, _now?: number, _queuedMs?: number): void {
    // MindPal is answering: any listening reaction asked for before now is stale.
    if (delta.trim()) this.speakingTurns += 1;
    if (!this.classify || this.reducedMotion) return;
    const before = this.speech.length;
    this.speech = mergeLiveTranscript(this.speech, delta);
    this.timeline.text(this.speech.length - before);
    let last = 0;
    for (const match of this.speech.matchAll(SENTENCE_END)) {
      const end = (match.index ?? 0) + match[0].length;
      this.queueSentence(this.speech.slice(last, end), this.speechBase + last, this.speechBase + end);
      last = end;
    }
    this.speech = this.speech.slice(last);
    this.speechBase += last;
  }

  /** A chunk of MindPal's audio was queued for playback. */
  modelAudio(ms: number, now: number, queuedMs: number): void {
    this.timeline.audio(ms, now, queuedMs);
  }

  /** MindPal finished generating: the last sentence may have no trailing space. */
  modelTurnEnded(now: number, queuedMs: number): void {
    if (this.speech.trim()) {
      this.queueSentence(this.speech, this.speechBase, this.speechBase + this.speech.length);
    }
    this.speechBase += this.speech.length;
    this.speech = '';
    if (queuedMs > 0) {
      const active = this.expressions.extendDuringPlayback(now + queuedMs);
      this.callbacks.onCommands?.(active);
    }
  }

  /** MindPal was cut off: nothing it had queued should still show on the face. */
  stopSpeaking(): void {
    this.dropSpeech();
    this.release('speech');
  }

  /**
   * MindPal's reply has finished playing: its tone lets go instead of lingering.
   * Checks still in flight are for sentences already heard, so they are dropped
   * too; waiting for them is how a look used to appear after the voice stopped.
   */
  speechEnded(): void {
    this.dropSpeech();
    this.release('speech');
    const now = this.clock();
    for (const item of this.expressions.active(now)) {
      if (item.source === 'tool' || item.source === 'user_request') {
        this.release(item.source);
      }
    }
  }

  /** Between the caller finishing and MindPal's first sound: eyes up and aside. */
  setThinking(on: boolean): void {
    this.thinking = on;
    this.syncState();
  }

  /** A memory or past-chat lookup started (+1) or finished (-1): eyes read back. */
  noteLookup(delta: 1 | -1): void {
    this.lookups = Math.max(0, this.lookups + delta);
    this.syncState();
  }

  /** Release expressions whose moment has come. Called every mic frame and on the call's clock. */
  tick(now: number): void {
    // Paced checks wait for their slot on the call's clock.
    if (this.sentences.length) this.pumpSpeech();
    if (!this.scheduled.length) return;
    const waiting: ScheduledLook[] = [];
    for (const item of this.scheduled) {
      if (this.timeline.timeAt(item.fromChar) > now) {
        waiting.push(item);
        continue;
      }
      const endsAt = this.timeline.timeAt(item.toChar);
      // Heard already (a slow check, or text that trailed its audio): skip it.
      if (endsAt - now < SPEECH_LOOK_STALE_MS) continue;
      const durationMs = Math.min(item.capMs, Math.max(SPEECH_LOOK_MIN_MS, endsAt - now));
      this.show({ ...item.command, startedAt: now, durationMs });
      if (item.reaction) this.callbacks.onReaction?.({ ...item.reaction, at: now });
    }
    this.scheduled = waiting;
  }

  private syncState(): void {
    const next: FaceState | null = this.lookups > 0 ? 'reading' : this.thinking ? 'thinking' : null;
    if (next === this.shownState) return;
    this.shownState = next;
    this.release('state');
    if (!next) return;
    this.show({ expression: next, intensity: 0.85, durationMs: STATE_HOLD_MS, startedAt: this.clock(), source: 'state' });
  }

  private release(source: ActiveExpression['source']): void {
    const list = this.expressions.release(source, this.clock());
    this.callbacks.onCommands?.(list);
  }

  private dropSpeech(): void {
    this.speechEpoch += 1;
    this.speech = '';
    this.speechBase = 0;
    this.timeline.reset();
    this.sentences = [];
    this.scheduled = [];
    this.speechTone = null;
    this.speechInFlight = 0;
  }

  private queueSentence(raw: string, fromChar: number, toChar: number): void {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!text) return;
    this.sentences.push({ text, fromChar, toChar });
    this.pumpSpeech();
  }

  private pumpSpeech(): void {
    const classify = this.classify;
    if (!classify || this.speechInFlight >= SPEECH_CLASSIFY_PARALLEL || !this.sentences.length) return;
    const now = this.clock();
    if (now - this.lastSpeechCheckAt < SPEECH_CLASSIFY_GAP_MS) return;
    this.lastSpeechCheckAt = now;
    this.classifySentence(classify, this.sentences.shift() as SpokenSentence);
  }

  private classifySentence(classify: ClassifyReaction, sentence: SpokenSentence): void {
    const epoch = this.speechEpoch;
    this.speechInFlight += 1;
    void classify(sentence.text, '', 'mindpal')
      .then((label) => {
        if (epoch !== this.speechEpoch) return;
        if (label === THROTTLED) {
          // Not a verdict. Ask once more if the sentence is still ahead of the voice.
          const endsAt = this.timeline.timeAt(sentence.toChar);
          if (!sentence.retried && endsAt - this.clock() > SPEECH_LOOK_STALE_MS) {
            this.sentences.unshift({ ...sentence, retried: true });
          }
          return;
        }
        const fresh = kindFor(label);
        // A neutral sentence keeps the reply's tone, softer, instead of dropping
        // the face to blank halfway through what MindPal is saying.
        const kind = fresh ?? this.speechTone;
        if (!kind) return;
        this.speechTone = kind;
        const look = reactionLook({ kind, at: 0, strength: 1 });
        if (!look) return;
        this.scheduled.push({
          command: {
            expression: look.expression,
            intensity: fresh ? look.intensity : look.intensity * 0.8,
            source: 'speech',
          },
          fromChar: sentence.fromChar,
          toChar: sentence.toChar,
          capMs: SPEECH_LOOK_MAX_MS[kind] ?? SPEECH_LOOK_CEILING_MS,
          // Head motion only for a fresh tone: a carried one would bounce every sentence.
          reaction: fresh ? { kind, strength: 0.7 } : null,
        });
        this.tick(this.clock());
      })
      .catch(() => {
        /* the face just stays on its speaking motion */
      })
      .finally(() => {
        // A reset already zeroed the count for checks from before it.
        if (epoch === this.speechEpoch) this.speechInFlight = Math.max(0, this.speechInFlight - 1);
        this.pumpSpeech();
      });
  }

  /** The call moved into support: the face stays gentle for the hold window. */
  support(now: number): void {
    this.distress.noteSupport(now);
    this.syncDistress(now);
  }

  /**
   * A face tool from the model. Returns null when the call is not a face tool,
   * otherwise whether it was applied.
   */
  tool(name: string, args: Record<string, unknown>, now: number, queuedMs = 0): boolean | null {
    if (name === 'set_expression') {
      const command = commandFromToolArgs(args, now);
      if (!command) return false;
      if (queuedMs > 0 && command.expression !== 'wink' && command.expression !== 'blink_slow') {
        command.durationMs = Math.max(command.durationMs, queuedMs + 400);
      }
      this.show(command);
      return true;
    }
    if (name === 'set_mood') {
      const mood = moodFromToolArgs(args);
      if (!mood) return false;
      this.callbacks.onAffect?.(
        this.affect.declare(mood.state, mood.intensity, { distress: this.distress.active(now), now }),
      );
      return true;
    }
    return null;
  }

  reset(): void {
    this.stopSpeaking();
    this.distress.reset();
    this.backchannelMem = createBackchannelMemory();
    this.syncDistress(0);
  }

  /**
   * Listening reactions. Timing comes from the voice: a phrase ending earns a nod
   * in any language. Meaning comes from the classifier, asked once per phrase.
   */
  private listen(voiced: boolean, context: FrameContext, distressed: boolean): void {
    this.listening = !context.modelSpeaking;
    if (context.modelSpeaking) {
      // Its own voice is not a phrase to nod at, and words said over it are stale
      // by the time it stops.
      this.phrases.reset();
      this.unread = '';
      return;
    }
    const phrase = this.phrases.frame(voiced, context.now);
    if (!phrase) return;
    if (!this.reducedMotion) {
      const nod = this.reactor.phraseEnd(phrase.speechMs, context.now);
      if (nod) this.react(nod);
    }
    this.askMeaning(context.now, distressed);
  }

  private askMeaning(now: number, distressed: boolean): void {
    if (!this.classify || this.reducedMotion || this.meaningInFlight) return;
    if (now - this.lastMeaningAt < MEANING_GAP_MS) return;
    const phrase = this.unread.replace(/\s+/g, ' ').trim();
    if (phrase.split(' ').filter(Boolean).length < MEANING_MIN_WORDS) return;
    const context = this.lastPhrase;
    this.unread = '';
    this.lastPhrase = phrase.slice(-300);
    this.meaningInFlight = true;
    this.lastMeaningAt = now;
    const askedDuringTurn = this.speakingTurns;
    void this.classify(phrase, context)
      .then((label) => {
        // Too late if MindPal has answered since the question was asked, even if
        // it has already finished: the reaction would now be to its own words.
        if (!this.listening || this.speakingTurns !== askedDuringTurn) return;
        const reaction = this.reactor.meaning(label, this.clock(), distressed);
        if (reaction) this.react(reaction);
      })
      .catch(() => {
        /* the nod already happened; a missing look is fine */
      })
      .finally(() => {
        this.meaningInFlight = false;
      });
  }

  private react(reaction: ListenerReaction): void {
    this.callbacks.onReaction?.(reaction);
    const look = reactionLook(reaction);
    if (!look) return;
    this.show({ ...look, startedAt: reaction.at, source: 'listener' });
  }

  private show(command: ActiveExpression): void {
    const list = this.expressions.push(command);
    this.callbacks.onExpression?.(command);
    this.callbacks.onCommands?.(list);
  }

  private syncDistress(now: number): boolean {
    const active = now > 0 && this.distress.active(now);
    if (active !== this.distressShown) {
      this.distressShown = active;
      this.callbacks.onDistress?.(active);
    }
    return active;
  }
}
