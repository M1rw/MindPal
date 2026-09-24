/**
 * Commanded face looks. Acoustic/expression names only — not a clinical model.
 * Capsule geometry matches the HTML orb face.
 */

export const FACE_EXPRESSIONS = [
  'wink',
  'blink_slow',
  'widen',
  'squint',
  'roll_eyes',
  'sleepy',
  'perk_up',
  'soften',
  'look_away',
  'look_back',
  'side_eye',
  'smile_eyes',
  'concerned',
  'curious',
  'surprised',
  'amused',
  'tired',
  'neutral',
  'heart',
  // Joy with its own silhouettes: laughing arcs, sparkle eyes, a blush.
  'laugh',
  'excited',
  'blush',
  // States, shown by the call rather than asked for: working out a reply, and
  // looking something up in memory or past chats.
  'thinking',
  'reading',
] as const;

export type FaceExpression = (typeof FACE_EXPRESSIONS)[number];

export function isFaceExpression(value: unknown): value is FaceExpression {
  return typeof value === 'string' && (FACE_EXPRESSIONS as readonly string[]).includes(value);
}

/**
 * The only looks allowed while distress is held. Everything else — drowsy lids,
 * averted gaze, squints, amusement — is suppressed rather than blocklisted one by one.
 */
export const DISTRESS_SAFE_EXPRESSIONS = new Set<FaceExpression>([
  'concerned',
  'soften',
  'neutral',
  'smile_eyes',
  'widen',
  'thinking',
  'reading',
]);

/** Eye silhouettes: capsule (default), heart, closed happy arc (^ ^), four-point sparkle. */
export type EyeShape = 'capsule' | 'heart' | 'arc' | 'star';

export interface ExpressionPose {
  /** Eye outline generator. Capsule unless a look needs its own silhouette. */
  shape?: EyeShape;
  width: number;
  height: number;
  spacing: number;
  angle: number;
  radius: number;
  offsetY: number;
  leftHeightMult: number;
  rightHeightMult: number;
  leftAngleAdd: number;
  rightAngleAdd: number;
  leftLid: number;
  rightLid: number;
  gazeOverrideX: number | null;
  gazeOverrideY: number | null;
  nod: number;
  lean: number;
  blinkIntervalScale: number;
  durationMs: number;
}

const BASE: Omit<ExpressionPose, 'durationMs'> = {
  width: 24,
  height: 52,
  spacing: 72,
  angle: 0,
  radius: 12,
  offsetY: -36,
  leftHeightMult: 1,
  rightHeightMult: 1,
  leftAngleAdd: 0,
  rightAngleAdd: 0,
  leftLid: 1,
  rightLid: 1,
  gazeOverrideX: null,
  gazeOverrideY: null,
  nod: 0,
  lean: 0,
  blinkIntervalScale: 1,
};

export const EXPRESSION_POSES: Record<FaceExpression, ExpressionPose> = {
  heart: {
    ...BASE,
    shape: 'heart',
    width: 34,
    height: 32,
    spacing: 74,
    offsetY: -40,
    radius: 10,
    // Deliberately long. A heart that vanishes in half a second reads as a
    // rendering glitch rather than an expression; this is a look someone asked
    // for on purpose, so it holds long enough to be seen and enjoyed.
    durationMs: 4200,
  },
  // Eyes squeezed into happy arcs (^ ^); the orb bobs while it lasts.
  laugh: { ...BASE, shape: 'arc', width: 34, height: 32, spacing: 80, offsetY: -36, radius: 10, blinkIntervalScale: 4, durationMs: 1800 },
  // Four-point sparkles that twinkle: big news, delight.
  excited: { ...BASE, shape: 'star', width: 34, height: 52, spacing: 82, offsetY: -40, blinkIntervalScale: 3, durationMs: 1600 },
  // Shy happy arcs and pink cheeks: a compliment, a sweet moment.
  blush: { ...BASE, shape: 'arc', width: 32, height: 26, spacing: 78, offsetY: -34, radius: 8, gazeOverrideX: -4, gazeOverrideY: 4, durationMs: 2400 },
  wink: { ...BASE, leftLid: 0.04, leftHeightMult: 0.2, rightHeightMult: 1.05, durationMs: 480 },
  blink_slow: { ...BASE, leftLid: 0.08, rightLid: 0.08, height: 28, durationMs: 900 },
  widen: { ...BASE, width: 26, height: 74, spacing: 80, offsetY: -44, leftHeightMult: 1.15, rightHeightMult: 1.15, durationMs: 900 },
  squint: { ...BASE, width: 22, height: 22, spacing: 62, radius: 10, leftHeightMult: 0.7, rightHeightMult: 0.7, durationMs: 1100 },
  roll_eyes: { ...BASE, height: 44, gazeOverrideX: 0, gazeOverrideY: -10, durationMs: 2800 },
  sleepy: {
    ...BASE,
    width: 24,
    height: 14,
    radius: 8,
    offsetY: -24,
    leftHeightMult: 0.35,
    rightHeightMult: 0.35,
    leftLid: 0.32,
    rightLid: 0.28,
    blinkIntervalScale: 0.45,
    durationMs: 2800,
  },
  perk_up: { ...BASE, width: 26, height: 70, spacing: 78, offsetY: -44, leftHeightMult: 1.12, rightHeightMult: 1.12, nod: 0.35, durationMs: 900 },
  soften: { ...BASE, width: 28, height: 34, spacing: 76, angle: -8, radius: 14, leftHeightMult: 0.75, rightHeightMult: 0.75, durationMs: 1600 },
  look_away: { ...BASE, height: 40, gazeOverrideX: -12, gazeOverrideY: 6, durationMs: 1800 },
  look_back: { ...BASE, gazeOverrideX: 0, gazeOverrideY: 0, durationMs: 700 },
  side_eye: {
    ...BASE,
    width: 22,
    height: 44,
    gazeOverrideX: 11,
    gazeOverrideY: 2,
    leftHeightMult: 0.7,
    rightHeightMult: 1.28,
    leftAngleAdd: 4,
    rightAngleAdd: -8,
    durationMs: 1400,
  },
  smile_eyes: { ...BASE, width: 28, height: 26, spacing: 76, angle: -10, radius: 14, leftHeightMult: 0.72, rightHeightMult: 0.72, durationMs: 1600 },
  concerned: { ...BASE, width: 26, height: 42, spacing: 70, angle: -8, radius: 13, offsetY: -28, leftHeightMult: 0.85, rightHeightMult: 0.85, durationMs: 1800 },
  curious: { ...BASE, width: 25, height: 68, spacing: 78, angle: -5, radius: 13, offsetY: -42, leftHeightMult: 1.12, rightHeightMult: 0.9, durationMs: 1400 },
  surprised: { ...BASE, width: 26, height: 76, spacing: 80, offsetY: -46, durationMs: 900 },
  amused: { ...BASE, width: 28, height: 26, spacing: 74, angle: -12, radius: 14, leftHeightMult: 0.8, rightHeightMult: 0.8, durationMs: 1400 },
  tired: { ...BASE, height: 20, radius: 9, offsetY: -26, leftLid: 0.55, rightLid: 0.5, blinkIntervalScale: 0.6, durationMs: 2200 },
  neutral: { ...BASE, durationMs: 600 },
  // Eyes up and to one side, a slight narrowing, few blinks: working out what to
  // say. Gaze drifts in faceBlend so it never freezes.
  thinking: {
    ...BASE,
    width: 24,
    height: 44,
    angle: -4,
    leftHeightMult: 0.92,
    rightHeightMult: 1.02,
    gazeOverrideX: 8,
    gazeOverrideY: -8,
    blinkIntervalScale: 1.8,
    durationMs: 20_000,
  },
  // Eyes lowered a touch and sweeping line by line, like reading back through notes.
  // The sweep itself is animated in faceBlend.
  reading: {
    ...BASE,
    width: 25,
    height: 40,
    leftHeightMult: 0.95,
    rightHeightMult: 0.95,
    gazeOverrideX: 0,
    gazeOverrideY: 3,
    blinkIntervalScale: 1.4,
    durationMs: 20_000,
  },
};

export type FaceChannel = 'gaze' | 'lids' | 'shape' | 'nod' | 'lean' | 'blink';

export const EXPRESSION_CHANNELS: Record<FaceExpression, readonly FaceChannel[]> = {
  // Shape only: a heart must not also drag the lids or gaze around.
  heart: ['shape'],
  laugh: ['shape', 'blink', 'nod'],
  excited: ['shape', 'blink'],
  blush: ['shape', 'gaze'],
  wink: ['lids'],
  blink_slow: ['lids', 'blink'],
  widen: ['shape'],
  squint: ['shape', 'lids'],
  roll_eyes: ['gaze'],
  sleepy: ['lids', 'shape', 'blink'],
  perk_up: ['shape', 'nod'],
  soften: ['shape'],
  look_away: ['gaze'],
  look_back: ['gaze'],
  side_eye: ['gaze', 'shape'],
  smile_eyes: ['shape'],
  concerned: ['shape'],
  curious: ['shape'],
  surprised: ['shape'],
  amused: ['shape'],
  tired: ['lids', 'shape', 'blink'],
  neutral: [],
  thinking: ['gaze', 'shape', 'blink'],
  reading: ['gaze', 'shape', 'blink'],
};

export function expressionChannels(expression: FaceExpression): readonly FaceChannel[] {
  return EXPRESSION_CHANNELS[expression];
}

export function channelsOverlap(a: FaceExpression, b: FaceExpression): boolean {
  const left = new Set(EXPRESSION_CHANNELS[a]);
  return EXPRESSION_CHANNELS[b].some((channel) => left.has(channel));
}

export function defaultDurationMs(expression: FaceExpression): number {
  return EXPRESSION_POSES[expression].durationMs;
}
