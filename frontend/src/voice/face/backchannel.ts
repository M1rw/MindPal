/**
 * Real-time listener backchannels while the user still holds the floor.
 * Visual always. Audible only from the session voice, never a stock clip.
 */

import { isAcousticDistress } from './distress.ts';
import { hasConcernLexicon } from './eyeTalk.ts';
import type { ProsodySnapshot } from './prosody.ts';
import type { FloorState } from '../types.ts';

export const CONTINUER_TEXTS = ['mm-hmm', 'yeah', 'go on', 'mhm'] as const;
export type ContinuerText = (typeof CONTINUER_TEXTS)[number];

export const VISUAL_MIN_TURN_MS = 700;
export const AUDIBLE_MIN_TURN_MS = 5500;
export const VISUAL_RATE_MS = 1100;
export const AUDIBLE_RATE_MS = 14000;
export const FIRST_SECONDS_MS = 2800;
export const CONTINUER_MAX_MS = 400;
export const AUDIBLE_PER_TURN = 1;
export const NEW_SPEECH_CHARS = 12;

const CONTINUER =
  /^(yeah|yes|yep|yup|ya|mm+|hmm+|mhm+|mm-?hmm+|uh-?huh|uh huh|uhu+|ok|okay|right|sure|alright|got it|نعم|اه+|آه+|أيوه|ايوة|أيوة|مم+|همم+|حاضر|طيب|أوك|اوك|تمام)$/i;

const NOT_CONTINUER = /\b(but|wait|except|however|because|and then|بس|لكن|يعني)\b/i;

/** "yeah", "mm-hmm", "أيوه": the listener keeping the speaker going, not taking the floor. */
export function isBackchannel(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.,!?،؟]+$/g, '')
    .replace(/\s+/g, ' ');
  if (!normalized || normalized.length > 24) return false;
  if (NOT_CONTINUER.test(normalized)) return false;
  if (normalized.split(' ').length > 2) return false;
  return CONTINUER.test(normalized);
}

export type VisualBackchannelKind = 'nod' | 'blink' | 'lean' | 'gaze';

export interface VisualBackchannel {
  kind: VisualBackchannelKind;
  strength: number;
  at: number;
}

export interface BackchannelInput {
  floor: FloorState;
  turnMs: number;
  transcript: string;
  prevTranscript?: string;
  prosody?: ProsodySnapshot | null;
  distress?: boolean;
  crisis?: boolean;
  modelSpeaking?: boolean;
  audibleEnabled?: boolean;
  reducedMotion?: boolean;
  overlayActive?: boolean;
  userEnergy?: number;
  selfTalkLock?: boolean;
  now?: number;
  /**
   * Precomputed transition-relevance, so a caller that already has it does not
   * run the transcript regexes twice per frame.
   */
  trp?: TrpCue;
}

export interface BackchannelMemory {
  lastVisualAt: number;
  lastAudibleAt: number;
  lastSpot: string;
  lastAudibleKind: string;
  lastTranscript: string;
  engagement: number;
  audibleThisTurn: number;
  turnHadSpeech: boolean;
  lastAudibleTranscript: string;
}

export interface BackchannelDecision {
  visual: VisualBackchannel | null;
  audible: ContinuerText | null;
  engagement: number;
  reason: string;
}

export interface TrpCue {
  fallingF0: boolean;
  energyDip: boolean;
  onsetGap: boolean;
  clauseBoundary: boolean;
  midWord: boolean;
  score: number;
}

export function createBackchannelMemory(): BackchannelMemory {
  return {
    lastVisualAt: 0,
    lastAudibleAt: 0,
    lastSpot: '',
    lastAudibleKind: '',
    lastTranscript: '',
    engagement: 0,
    audibleThisTurn: 0,
    turnHadSpeech: false,
    lastAudibleTranscript: '',
  };
}

export function isMidWord(transcript: string, prosody?: ProsodySnapshot | null): boolean {
  const text = transcript.trim();
  if (!text) return false;
  if (/[,.!?،؟…—–]\s*$/.test(text)) return false;
  const since = prosody?.sinceOnsetMs ?? 9999;
  if ((prosody?.voiced ?? false) && since < 110) return true;
  return /[\p{L}\p{N}]$/u.test(text) && (prosody?.shortLong ?? 1) > 1.05 && since < 160;
}

export function transitionRelevance(prosody: ProsodySnapshot | null | undefined, transcript: string): TrpCue {
  const fallingF0 = (prosody?.f0Slope ?? 0) < -8;
  const energyDip = (prosody?.shortLong ?? 1) < 0.85;
  const onsetGap = (prosody?.sinceOnsetMs ?? 0) > 180 && (prosody?.sinceOnsetMs ?? 0) < 1100;
  const clauseBoundary = /[,.!?،؟…]\s*$/.test(transcript.trim());
  const midWord = isMidWord(transcript, prosody);
  let score = 0;
  if (fallingF0) score += 1;
  if (energyDip) score += 1;
  if (onsetGap) score += 1;
  if (clauseBoundary) score += 1.5;
  if (midWord) score = 0;
  return { fallingF0, energyDip, onsetGap, clauseBoundary, midWord, score };
}

export function genuineNewSpeech(prev: string, next: string): boolean {
  const before = prev.replace(/\s+/g, ' ').trim();
  const after = next.replace(/\s+/g, ' ').trim();
  if (after.length < before.length + NEW_SPEECH_CHARS) return false;
  const delta = after.slice(before.length).trim();
  if (!delta) return false;
  if (isBackchannel(delta) || isBackchannel(after)) return false;
  return true;
}

export function evaluateBackchannel(input: BackchannelInput, mem: BackchannelMemory): BackchannelDecision {
  const now = input.now ?? Date.now();
  const transcript = input.transcript.replace(/\s+/g, ' ').trim();
  const distress =
    Boolean(input.distress) || hasConcernLexicon(transcript) || isAcousticDistress(input.prosody);
  const crisis = Boolean(input.crisis) || input.floor === 'crisis_freeze';
  const modelSpeaking = Boolean(input.modelSpeaking) || input.floor === 'speaking' || input.floor === 'overlapping';
  const userFloor = input.floor === 'listening' || input.floor === 'holding';
  const turnMs = Math.max(0, input.turnMs);
  if (turnMs < 350) {
    mem.audibleThisTurn = 0;
    mem.turnHadSpeech = false;
  }
  const trp = input.trp ?? transitionRelevance(input.prosody, transcript);
  const spot = String(Math.floor(transcript.length / 14));
  mem.engagement = userFloor && turnMs > 400 ? Math.min(0.38, turnMs / 18000) : mem.engagement * 0.96;

  if (crisis) {
    return emptyDecision(mem, 'crisis');
  }
  if (!userFloor || modelSpeaking || input.overlayActive) {
    return emptyDecision(mem, input.overlayActive ? 'overlay_gate' : 'not_user_floor');
  }
  if (distress) {
    return emptyDecision(mem, 'distress');
  }
  if (turnMs < VISUAL_MIN_TURN_MS) {
    return emptyDecision(mem, 'too_early');
  }
  if (trp.midWord) {
    return emptyDecision(mem, 'mid_word');
  }
  if (trp.score < 2) {
    return { visual: null, audible: null, engagement: mem.engagement, reason: 'no_trp' };
  }

  let visual: VisualBackchannel | null = null;
  if (!input.reducedMotion && now - mem.lastVisualAt >= VISUAL_RATE_MS && mem.lastSpot !== spot) {
    const kind = pickVisual(trp, turnMs);
    visual = { kind, strength: visualStrength(kind, turnMs, mem.engagement), at: now };
    mem.lastVisualAt = now;
    mem.lastSpot = spot;
  }

  let audible: ContinuerText | null = null;
  const optedIn = input.audibleEnabled === true;
  const newSpeech = genuineNewSpeech(mem.lastAudibleTranscript, transcript);
  const audibleOk =
    optedIn &&
    !input.selfTalkLock &&
    !input.reducedMotion &&
    !input.overlayActive &&
    (input.userEnergy ?? 0) > 0.12 &&
    turnMs >= AUDIBLE_MIN_TURN_MS &&
    turnMs >= FIRST_SECONDS_MS &&
    mem.audibleThisTurn < AUDIBLE_PER_TURN &&
    now - mem.lastAudibleAt >= AUDIBLE_RATE_MS &&
    (mem.audibleThisTurn === 0 || newSpeech) &&
    trp.score >= 2.5 &&
    (trp.clauseBoundary || (trp.fallingF0 && trp.energyDip)) &&
    !trp.midWord;
  if (audibleOk) {
    audible = pickContinuer(mem.lastAudibleKind);
    mem.lastAudibleAt = now;
    mem.lastAudibleKind = audible;
    mem.audibleThisTurn += 1;
    mem.lastAudibleTranscript = transcript;
  }

  mem.lastTranscript = transcript;
  return {
    visual,
    audible,
    engagement: mem.engagement,
    reason: visual || audible ? 'trp' : 'rate_limited',
  };
}

function emptyDecision(mem: BackchannelMemory, reason: string): BackchannelDecision {
  return { visual: null, audible: null, engagement: mem.engagement, reason };
}

function pickVisual(trp: TrpCue, turnMs: number): VisualBackchannelKind {
  if (trp.clauseBoundary && turnMs > 2400) return 'nod';
  if (trp.onsetGap && trp.energyDip) return 'blink';
  if (turnMs > 8000) return 'lean';
  return 'gaze';
}

export function visualStrength(kind: VisualBackchannelKind, turnMs: number, engagement: number): number {
  const long = Math.min(1, turnMs / 14000);
  if (kind === 'nod') return 0.42 + long * 0.2 + engagement;
  if (kind === 'lean') return 0.28 + long * 0.25;
  if (kind === 'blink') return 0.55;
  return 0.35 + engagement;
}

/** A real saccade offset for a gaze backchannel. Zero is a no-op. */
export function gazeBackchannelSaccade(
  strength = 0.35,
  random: () => number = Math.random,
): { x: number; y: number; holdMs: number } {
  const k = Math.max(0.25, Math.min(1, strength));
  const side = random() >= 0.5 ? 1 : -1;
  return {
    x: side * (6 + k * 8),
    y: (random() - 0.5) * (3 + k * 4),
    holdMs: 220,
  };
}

function pickContinuer(last: string): ContinuerText {
  const pool = CONTINUER_TEXTS.filter((text) => text !== last);
  const choices = pool.length ? pool : [...CONTINUER_TEXTS];
  return choices[Math.floor(Math.random() * choices.length)] || 'mm-hmm';
}
