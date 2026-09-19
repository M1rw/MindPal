/**
 * MindPal's own expressed state. Acoustic + model-declared — not user-emotion detection.
 * Strain is capped so the face never looks hostile or dismissive.
 */

import { isAcousticDistress } from './distress.ts';
import type { ProsodySnapshot } from './prosody.ts';

export const STRAIN_CAP = 0.42;

/** Below this the face reads as drowsy, so acoustic evidence alone may never cross it. */
export const SLEEPY_ALERTNESS = 0.32;
export const ACOUSTIC_ALERTNESS_FLOOR = 0.38;

/** Model-declared moods are smoothed and rate-limited so repeated calls cannot compound. */
export const DECLARE_MIN_INTERVAL_MS = 400;
export const DISTRESS_SAFE_MOODS = new Set<MoodState>(['concerned', 'warm', 'calm']);

export interface AffectLevels {
  alertness: number;
  engagement: number;
  strain: number;
  warmth: number;
}

export interface AffectEvidence {
  prosody?: ProsodySnapshot | null;
  playbackEnergy?: number;
  userEnergy?: number;
  distress?: boolean;
  crisis?: boolean;
  dtMs?: number;
}

export const AFFECT_IDLE: AffectLevels = {
  alertness: 0.62,
  engagement: 0.58,
  strain: 0,
  warmth: 0.64,
};

const ATTACK = { alertness: 0.32, engagement: 0.09, strain: 0.012, warmth: 0.07 };
const RELEASE = { alertness: 0.016, engagement: 0.02, strain: 0.038, warmth: 0.018 };

export const MOOD_STATES = [
  'awake',
  'sleepy',
  'engaged',
  'withdrawn',
  'calm',
  'firm',
  'warm',
  'concerned',
] as const;

export type MoodState = (typeof MOOD_STATES)[number];

export function isMoodState(value: string): value is MoodState {
  return (MOOD_STATES as readonly string[]).includes(value);
}

export function moodStateTarget(state: MoodState, intensity = 1): Partial<AffectLevels> {
  const k = clamp01(intensity);
  switch (state) {
    case 'awake':
      return { alertness: mix(0.62, 0.95, k) };
    case 'sleepy':
      return { alertness: mix(0.62, 0.18, k) };
    case 'engaged':
      return { engagement: mix(0.58, 0.92, k) };
    case 'withdrawn':
      return { engagement: mix(0.58, 0.28, k) };
    case 'calm':
      return { strain: 0, warmth: mix(0.64, 0.8, k) };
    case 'firm':
      return { strain: mix(0.08, STRAIN_CAP, k), warmth: mix(0.64, 0.5, k) };
    case 'warm':
      return { warmth: mix(0.64, 0.95, k), strain: 0 };
    case 'concerned':
      return { warmth: mix(0.7, 0.9, k), engagement: mix(0.65, 0.88, k), strain: 0, alertness: mix(0.6, 0.72, k) };
    default:
      return {};
  }
}

/** Latched safety state supplied by the session; `declare` must not be able to escape it. */
export interface MoodGuard {
  distress?: boolean;
  crisis?: boolean;
  now?: number;
}

export class AffectModel {
  levels: AffectLevels = { ...AFFECT_IDLE };
  private lastDeclareAt = 0;

  snapshot(): AffectLevels {
    return { ...this.levels };
  }

  declare(state: MoodState, intensity = 1, guard: MoodGuard = {}): AffectLevels {
    const now = guard.now ?? Date.now();
    if (guard.crisis) {
      this.applySafetyFloor();
      return this.snapshot();
    }
    if (this.lastDeclareAt && now - this.lastDeclareAt < DECLARE_MIN_INTERVAL_MS) return this.snapshot();
    this.lastDeclareAt = now;
    const effective = guard.distress && !DISTRESS_SAFE_MOODS.has(state) ? 'concerned' : state;
    const target = moodStateTarget(effective, intensity);
    if (typeof target.alertness === 'number') this.levels.alertness = approach(this.levels.alertness, target.alertness, 0.45, 0.45);
    if (typeof target.engagement === 'number') this.levels.engagement = approach(this.levels.engagement, target.engagement, 0.28, 0.28);
    if (typeof target.strain === 'number') this.levels.strain = Math.min(STRAIN_CAP, approach(this.levels.strain, target.strain, 0.2, 0.2));
    if (typeof target.warmth === 'number') this.levels.warmth = approach(this.levels.warmth, target.warmth, 0.28, 0.28);
    if (guard.distress) this.applySafetyFloor();
    return this.snapshot();
  }

  tick(evidence: AffectEvidence): AffectLevels {
    const dt = Math.min(200, Math.max(16, evidence.dtMs ?? 50));
    const scale = dt / 50;
    if (evidence.crisis || evidence.distress || isAcousticDistress(evidence.prosody)) {
      this.applySafetyFloor();
      return this.snapshot();
    }
    const target = evidenceTarget(evidence);
    this.levels.alertness = approach(this.levels.alertness, target.alertness, ATTACK.alertness * scale, RELEASE.alertness * scale);
    this.levels.engagement = approach(this.levels.engagement, target.engagement, ATTACK.engagement * scale, RELEASE.engagement * scale);
    this.levels.strain = Math.min(
      STRAIN_CAP,
      approach(this.levels.strain, target.strain, ATTACK.strain * scale, RELEASE.strain * scale),
    );
    this.levels.warmth = approach(this.levels.warmth, target.warmth, ATTACK.warmth * scale, RELEASE.warmth * scale);
    return this.snapshot();
  }

  /** Warm, awake, unstrained. The one shape the face is allowed to hold under distress. */
  private applySafetyFloor(): void {
    this.levels.strain = 0;
    this.levels.warmth = Math.max(this.levels.warmth, 0.82);
    this.levels.engagement = Math.max(this.levels.engagement, 0.78);
    this.levels.alertness = Math.max(this.levels.alertness, 0.58);
  }
}

function evidenceTarget(evidence: AffectEvidence): AffectLevels {
  const target = { ...AFFECT_IDLE };
  const prosody = evidence.prosody;
  const play = clamp01(evidence.playbackEnergy ?? 0);
  const user = clamp01(evidence.userEnergy ?? 0);
  if (prosody?.state === 'energetic') {
    target.alertness = 0.92;
    target.engagement = 0.86;
    target.warmth = 0.7;
  } else if (prosody?.state === 'flattening') {
    // A flat monotone is a reason to stay present, never a reason to look drowsy.
    target.alertness = 0.62;
    target.engagement = 0.78;
    target.warmth = 0.82;
    target.strain = 0;
  } else if (prosody?.state === 'quiet') {
    target.engagement = 0.44;
    target.alertness = 0.5;
  } else if (prosody?.state === 'agitated') {
    // Loud, fast, rising speech gets warmth and attention, not a firmer face.
    target.strain = 0;
    target.warmth = 0.88;
    target.alertness = 0.72;
    target.engagement = 0.86;
  } else if (prosody?.state === 'steady') {
    target.alertness = 0.66;
    target.engagement = 0.62;
  }
  if (user > 0.08 && (prosody?.turnMs ?? 0) > 800) {
    const long = Math.min(0.34, (prosody?.turnMs ?? 0) / 18000);
    target.engagement = Math.max(target.engagement, 0.58 + long);
    target.alertness = Math.max(target.alertness, 0.6 + long * 0.2);
  }
  if (user > 0.55) target.alertness = Math.max(target.alertness, 0.88);
  if (play > 0.2) target.alertness = Math.max(target.alertness, 0.6);
  target.alertness = Math.max(target.alertness, ACOUSTIC_ALERTNESS_FLOOR);
  target.strain = Math.min(STRAIN_CAP, Math.max(0, target.strain));
  return target;
}

/** Exponential so the same wall-clock gap moves the same distance at any tick rate. */
function approach(current: number, target: number, attack: number, release: number): number {
  const coeff = Math.max(0, target > current ? attack : release);
  const rate = 1 - Math.exp(-coeff);
  return clamp01(current + (target - current) * Math.min(1, rate));
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
