/** Exact gaze math from gradient_ai_voice_circle_face HTML. Not an emotion model. */

export const HTML_GAZE_RANGE_X = 12;
export const HTML_GAZE_RANGE_Y = 10;
export const HTML_GAZE_MAX_DIST_FACTOR = 0.4;
export const HTML_GAZE_STIFFNESS = 0.05;
export const HTML_GAZE_DAMPING = 0.85;
export const HTML_PULSE_STIFFNESS = 0.09;
export const HTML_PULSE_DAMPING = 0.8;
export const HTML_ORB_RADIUS_REF = 180;
export const HTML_EYE = {
  width: 24,
  height: 52,
  spacing: 72,
  radius: 12,
  offsetY: -36,
} as const;

/** SpringValue from the HTML: force = (target - current) * k; v = (v + force) * d. */
export class SpringValue {
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

  /** A non-finite target is dropped so the gaze channel can always recover. */
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

  /** Integrates in 60fps HTML steps so 120Hz does not double the feel. */
  update(dtMs = 1000 / 60): number {
    const step = 1000 / 60;
    this.acc += Number.isFinite(dtMs) ? Math.min(48, Math.max(0, dtMs)) : step;
    while (this.acc >= step) {
      const force = (this.target - this.current) * this.stiffness;
      const velocity = (this.velocity + force) * this.damping;
      const next = this.current + velocity;
      if (Number.isFinite(next)) {
        this.velocity = velocity;
        this.current = next;
      } else {
        this.velocity = 0;
      }
      this.acc -= step;
    }
    return this.current;
  }
}

/**
 * HTML updatePhysics gaze: dx/dy from mouse client to canvas center,
 * maxDist = min(width, height) * 0.4, then *12 / *10, clamp ±12 / ±10.
 * For a 280px overlay canvas, pass window inner size as width/height so
 * travel across the overlay maps the same as the fullscreen HTML canvas.
 */
export function htmlGazeTarget(
  mouseX: number,
  mouseY: number,
  centerX: number,
  centerY: number,
  fieldWidth: number,
  fieldHeight: number,
): { x: number; y: number } {
  const dx = mouseX - centerX;
  const dy = mouseY - centerY;
  const maxDist = Math.max(1, Math.min(fieldWidth, fieldHeight) * HTML_GAZE_MAX_DIST_FACTOR);
  let gazeTargetX = (dx / maxDist) * HTML_GAZE_RANGE_X;
  let gazeTargetY = (dy / maxDist) * HTML_GAZE_RANGE_Y;
  gazeTargetX = Number.isFinite(gazeTargetX)
    ? Math.max(-HTML_GAZE_RANGE_X, Math.min(HTML_GAZE_RANGE_X, gazeTargetX))
    : 0;
  gazeTargetY = Number.isFinite(gazeTargetY)
    ? Math.max(-HTML_GAZE_RANGE_Y, Math.min(HTML_GAZE_RANGE_Y, gazeTargetY))
    : 0;
  return { x: gazeTargetX, y: gazeTargetY };
}

/** Neutral capsule from EyeShapes.capsule — 15 steps per corner, 60 points. */
/**
 * Heart-shaped eye outline, same contract as `capsuleEyePoints`: a closed
 * polygon centred on the origin, sized to w/h, so the existing draw path,
 * blink scaling and rotation all keep working unchanged.
 *
 * Parametric heart, flipped in y because canvas y grows downward.
 */
export function heartEyePoints(w: number, h: number, steps = 46): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  // The classic curve spans roughly x:[-16,16], y:[-17,13]; normalise to w/h.
  const sx = w / 32;
  const sy = h / 30;
  for (let i = 0; i < steps; i += 1) {
    const t = (i / steps) * Math.PI * 2;
    const x = 16 * Math.sin(t) ** 3;
    const y =
      13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pts.push({ x: x * sx, y: -y * sy });
  }
  return pts;
}

export function capsuleEyePoints(w: number, h: number, corner: number): Array<{ x: number; y: number }> {
  const r = Math.max(0.1, Math.min(corner, w / 2, h / 2));
  const pts: Array<{ x: number; y: number }> = [];
  const steps = 15;
  for (let i = 0; i < steps; i += 1) {
    const a = -Math.PI / 2 + (i / (steps - 1)) * (Math.PI / 2);
    pts.push({ x: w / 2 - r + Math.cos(a) * r, y: -h / 2 + r + Math.sin(a) * r });
  }
  for (let i = 0; i < steps; i += 1) {
    const a = 0 + (i / (steps - 1)) * (Math.PI / 2);
    pts.push({ x: w / 2 - r + Math.cos(a) * r, y: h / 2 - r + Math.sin(a) * r });
  }
  for (let i = 0; i < steps; i += 1) {
    const a = Math.PI / 2 + (i / (steps - 1)) * (Math.PI / 2);
    pts.push({ x: -w / 2 + r + Math.cos(a) * r, y: h / 2 - r + Math.sin(a) * r });
  }
  for (let i = 0; i < steps; i += 1) {
    const a = Math.PI + (i / (steps - 1)) * (Math.PI / 2);
    pts.push({ x: -w / 2 + r + Math.cos(a) * r, y: -h / 2 + r + Math.sin(a) * r });
  }
  return pts;
}
