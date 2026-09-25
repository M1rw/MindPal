/**
 * Eyes that morph between shapes instead of swapping them.
 *
 * Each look has its own outline (capsule, heart, ^ arc, sparkle), built by its
 * own generator with its own point count and starting point, so the face used
 * to jump from one polygon to the next the moment a reaction took over. Here
 * every outline is resampled to the same number of points, evenly spaced along
 * its edge, starting at the top centre and running the same way round. Shapes
 * then blend point by point, and each shape's weight eases toward its target,
 * so a capsule melts into a heart and back.
 */
import { arcEyePoints, capsuleEyePoints, heartEyePoints, starEyePoints } from './gaze.ts';

export type MorphShape = 'capsule' | 'heart' | 'arc' | 'star';
export type Point = { x: number; y: number };

export const MORPH_POINTS = 72;
/** Time constant of a shape change: ~95% of the way there in 3τ ≈ 330ms. */
export const MORPH_TAU_MS = 110;

const SHAPES: readonly MorphShape[] = ['capsule', 'heart', 'arc', 'star'];

function signedArea(pts: readonly Point[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

/**
 * `pts` as `count` points evenly spaced along the closed outline, clockwise on
 * screen, starting from the topmost point nearest the vertical centre line.
 */
export function resampleOutline(pts: readonly Point[], count = MORPH_POINTS): Point[] {
  if (pts.length < 3) return Array.from({ length: count }, () => ({ x: 0, y: 0 }));
  let ring = signedArea(pts) < 0 ? [...pts].reverse() : [...pts];
  // Start where the outline crosses the vertical centre line highest up (the
  // top of a capsule, the notch of a heart, the crown of an arc). Starting at
  // the topmost point instead put a heart's start on one lobe, which twisted
  // morphs to and from it.
  let best: { index: number; point: Point } | null = null;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if ((a.x <= 0 && b.x > 0) || (a.x >= 0 && b.x < 0)) {
      const t = a.x === b.x ? 0 : -a.x / (b.x - a.x);
      const point = { x: 0, y: a.y + (b.y - a.y) * t };
      if (!best || point.y < best.point.y) best = { index: i, point };
    }
  }
  if (best) ring = [best.point, ...ring.slice(best.index + 1), ...ring.slice(0, best.index + 1)];
  const lengths = [0];
  for (let i = 1; i <= ring.length; i += 1) {
    const a = ring[i - 1];
    const b = ring[i % ring.length];
    lengths.push(lengths[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const total = lengths[lengths.length - 1] || 1;
  const out: Point[] = [];
  let seg = 0;
  for (let k = 0; k < count; k += 1) {
    const target = (k / count) * total;
    while (seg < ring.length - 1 && lengths[seg + 1] < target) seg += 1;
    const a = ring[seg];
    const b = ring[(seg + 1) % ring.length];
    const span = lengths[seg + 1] - lengths[seg] || 1;
    const t = (target - lengths[seg]) / span;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

export function outlineFor(shape: MorphShape, w: number, h: number, corner: number): Point[] {
  if (shape === 'heart') return resampleOutline(heartEyePoints(w, h));
  if (shape === 'arc') return resampleOutline(arcEyePoints(w, h));
  if (shape === 'star') return resampleOutline(starEyePoints(w, h));
  return resampleOutline(capsuleEyePoints(w, h, corner));
}

export class EyeMorph {
  private weights: Record<MorphShape, number> = { capsule: 1, heart: 0, arc: 0, star: 0 };

  /** Ease each shape's weight toward the target shape. `snap` (reduced motion) jumps. */
  update(target: MorphShape, dtMs: number, snap = false): void {
    const k = snap ? 1 : 1 - Math.exp(-Math.max(0, dtMs) / MORPH_TAU_MS);
    for (const shape of SHAPES) {
      const goal = shape === target ? 1 : 0;
      const next = this.weights[shape] + (goal - this.weights[shape]) * k;
      this.weights[shape] = Math.abs(next - goal) < 0.002 ? goal : next;
    }
  }

  /** How much of `shape` is showing, 0..1. */
  weight(shape: MorphShape): number {
    const sum = SHAPES.reduce((acc, s) => acc + this.weights[s], 0) || 1;
    return this.weights[shape] / sum;
  }

  /** The blended outline at this size. */
  points(w: number, h: number, corner: number): Point[] {
    const sum = SHAPES.reduce((acc, s) => acc + this.weights[s], 0) || 1;
    const active = SHAPES.filter((s) => this.weights[s] > 0);
    if (active.length === 1) return outlineFor(active[0], w, h, corner);
    const out = Array.from({ length: MORPH_POINTS }, () => ({ x: 0, y: 0 }));
    for (const shape of active) {
      const share = this.weights[shape] / sum;
      const pts = outlineFor(shape, w, h, corner);
      for (let i = 0; i < MORPH_POINTS; i += 1) {
        out[i].x += pts[i].x * share;
        out[i].y += pts[i].y * share;
      }
    }
    return out;
  }
}
