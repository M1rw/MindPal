/**
 * Shared motion: dt-aware springs, slew limits, pose crossfade.
 * Tuned per channel so gaze stays HTML-slow and lids stay snappy.
 */

export type PresencePose = 'idle' | 'listening' | 'speaking' | 'yielding' | 'holding' | 'crisis';

export const REF_DT_MS = 1000 / 60;

export const SPRING = {
  gaze: { stiffness: 0.05, damping: 0.85 },
  pulse: { stiffness: 0.09, damping: 0.8 },
  lids: { stiffness: 0.32, damping: 0.55 },
  eyes: { stiffness: 0.22, damping: 0.62 },
  nod: { stiffness: 0.14, damping: 0.72 },
  mood: { stiffness: 0.04, damping: 0.9 },
} as const;

/** Max change per 16.67ms frame. Geometry cannot jump a full pose in one tick. */
export const SLEW_PER_FRAME = {
  nod: 0.085,
  lean: 0.08,
  height: 3.2,
  width: 1.6,
  spacing: 2.2,
  offsetY: 1.8,
  radius: 1.1,
  pulse: 0.12,
  lid: 0.22,
  gaze: 1.8,
  beat: 0.14,
} as const;

export const POSE_CROSSFADE_MS = 280;

export class MotionSpring {
  current: number;
  target: number;
  velocity = 0;
  stiffness: number;
  damping: number;
  private acc = 0;

  constructor(val = 0, stiffness = 0.08, damping = 0.82) {
    this.current = val;
    this.target = val;
    this.stiffness = stiffness;
    this.damping = damping;
  }

  /** A non-finite target is dropped: one bad frame must not blank the channel forever. */
  set(val: number): void {
    if (!Number.isFinite(val)) return;
    this.target = val;
  }

  snap(val: number): void {
    const next = Number.isFinite(val) ? val : this.current;
    this.current = Number.isFinite(next) ? next : 0;
    this.target = this.current;
    this.velocity = 0;
    this.acc = 0;
  }

  /** HTML spring integrated in 60fps steps so refresh rate does not change the feel. */
  update(dtMs = REF_DT_MS): number {
    this.acc += Number.isFinite(dtMs) ? Math.min(48, Math.max(0, dtMs)) : REF_DT_MS;
    while (this.acc >= REF_DT_MS) {
      const force = (this.target - this.current) * this.stiffness;
      const velocity = (this.velocity + force) * this.damping;
      const next = this.current + velocity;
      if (Number.isFinite(next)) {
        this.velocity = velocity;
        this.current = next;
      } else {
        this.velocity = 0;
      }
      this.acc -= REF_DT_MS;
    }
    return this.current;
  }
}

export function slewLimit(current: number, target: number, maxDelta: number): number {
  if (!Number.isFinite(current)) return Number.isFinite(target) ? target : 0;
  if (!Number.isFinite(target) || maxDelta <= 0) return current;
  const delta = target - current;
  if (delta > maxDelta) return current + maxDelta;
  if (delta < -maxDelta) return current - maxDelta;
  return target;
}

export function slewForDt(perFrame: number, dtMs: number): number {
  return perFrame * Math.min(3, Math.max(0.25, dtMs / REF_DT_MS));
}

const POSES: PresencePose[] = ['idle', 'listening', 'speaking', 'yielding', 'holding', 'crisis'];

export class PoseMixer {
  weights: Record<PresencePose, number> = {
    idle: 1,
    listening: 0,
    speaking: 0,
    yielding: 0,
    holding: 0,
    crisis: 0,
  };

  tick(pose: PresencePose, dtMs: number, durationMs = POSE_CROSSFADE_MS): void {
    if (pose === 'crisis' || durationMs <= 0) {
      this.snap(pose);
      return;
    }
    const rate = 1 - Math.exp((-3 * Math.max(0, dtMs)) / durationMs);
    for (const key of POSES) {
      const target = key === pose ? 1 : 0;
      this.weights[key] += (target - this.weights[key]) * rate;
    }
  }

  snap(pose: PresencePose): void {
    for (const key of POSES) this.weights[key] = key === pose ? 1 : 0;
  }

  blend(values: Partial<Record<PresencePose, number>>): number {
    let sum = 0;
    for (const key of POSES) sum += (values[key] ?? 0) * this.weights[key];
    return sum;
  }
}

export function maxAbsDelta(prev: number[], next: number[]): number {
  const n = Math.min(prev.length, next.length);
  let max = 0;
  for (let i = 0; i < n; i += 1) {
    max = Math.max(max, Math.abs((next[i] ?? 0) - (prev[i] ?? 0)));
  }
  return max;
}

export class CueLock<T extends string> {
  private value: T;
  private since = 0;

  constructor(initial: T) {
    this.value = initial;
  }

  hold(next: T, now: number, minDwellMs = 180): T {
    if (next === this.value) return this.value;
    if (this.since && now - this.since < minDwellMs) return this.value;
    this.value = next;
    this.since = now;
    return this.value;
  }

  get current(): T {
    return this.value;
  }
}
