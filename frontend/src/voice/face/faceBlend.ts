/**
 * Channel-composing face blend.
 * Speech owns talk envelope. Commands claim only the channels they need.
 * Crisis still overrides everything.
 */

import { SLEEPY_ALERTNESS, type AffectLevels } from './affect.ts';
import { isAcousticDistress } from './distress.ts';
import { hasConcernLexicon, type EyeTalkShape } from './eyeTalk.ts';
import { EXPRESSION_CHANNELS, EXPRESSION_POSES, type FaceChannel, type FaceExpression } from './expressionCatalog.ts';
import {
  allowExpressionUnderDistress,
  commandEnvelope,
  isCommandActive,
  type ActiveExpression,
} from './expressionCommand.ts';
import type { ProsodySnapshot, ProsodyState } from './prosody.ts';

export interface FaceBlendInput {
  speech: EyeTalkShape;
  prosody?: ProsodySnapshot | null;
  command?: ActiveExpression | null;
  commands?: ActiveExpression[] | null;
  affect?: AffectLevels | null;
  userTranscript: string;
  crisis: boolean;
  /** Latched distress from the session. The lexical and acoustic checks below are the fallback. */
  distress?: boolean;
  now?: number;
}

/** Open eyes, level lids, a small lean in. Held whatever else is queued. */
const DISTRESS_EYE_HEIGHT = 56;
const DISTRESS_BLINK_SCALE = 0.85;
const DISTRESS_LEAN = 0.12;

export interface FaceBlendResult {
  eyes: EyeTalkShape;
  leftLid: number;
  rightLid: number;
  gazeOverrideX: number | null;
  gazeOverrideY: number | null;
  nodAdd: number;
  leanAdd: number;
  blinkIntervalScale: number;
  expression: FaceExpression | 'speech';
  mood: ProsodyState | 'idle';
  /** Eye silhouette the active look asks for. Capsule unless stated. */
  shape: 'capsule' | 'heart';
  commandName: FaceExpression | '';
  commandWeight: number;
  distress: boolean;
  talkActive: boolean;
}

export function isDistressContext(input: {
  crisis: boolean;
  userTranscript: string;
  prosody?: ProsodySnapshot | null;
  distress?: boolean;
}): boolean {
  if (input.crisis) return true;
  if (input.distress) return true;
  if (hasConcernLexicon(input.userTranscript)) return true;
  return isAcousticDistress(input.prosody);
}

export function blendFaceLayers(input: FaceBlendInput): FaceBlendResult {
  const now = input.now ?? Date.now();
  const distress = isDistressContext(input);
  const mood: ProsodyState | 'idle' = input.crisis ? 'idle' : input.prosody?.state || 'idle';
  const talkActive = input.speech.role === 'model';
  let eyes = { ...input.speech };
  let leftLid = 1;
  let rightLid = 1;
  let gazeOverrideX: number | null = null;
  let gazeOverrideY: number | null = null;
  let nodAdd = 0;
  let leanAdd = 0;
  let blinkIntervalScale = 1;
  let expression: FaceExpression | 'speech' = 'speech';
  let commandName: FaceExpression | '' = '';
  let commandWeight = 0;

  if (input.crisis) {
    return {
      eyes: { ...eyes, cue: 'idle', height: 52, width: 24, leftHeightMult: 1, rightHeightMult: 1, leftLid: 1, rightLid: 1 },
      leftLid: 1,
      rightLid: 1,
      gazeOverrideX: 0,
      gazeOverrideY: 0,
      nodAdd: 0,
      leanAdd: 0,
      blinkIntervalScale: 0.4,
      expression: 'neutral',
      mood: 'idle',
      // Distress suppresses decorative looks entirely, silhouette included.
      shape: 'capsule',
      commandName: '',
      commandWeight: 0,
      distress: true,
      talkActive: false,
    };
  }

  applyAffect(eyes, input.affect, distress);
  if (distress) {
    eyes.height = Math.max(eyes.height, DISTRESS_EYE_HEIGHT);
    leftLid = 1;
    rightLid = 1;
    blinkIntervalScale = DISTRESS_BLINK_SCALE;
    leanAdd += DISTRESS_LEAN;
  }

  const queued = (input.commands?.length ? input.commands : input.command ? [input.command] : []).filter((item) =>
    isCommandActive(item, now),
  );
  for (const command of queued) {
    if (!allowExpressionUnderDistress(command.expression, distress)) continue;
    const weight = commandEnvelope(command, now);
    if (weight <= 0.01) continue;
    const pose = animatedCommandPose(command, now);
    const channels = new Set<FaceChannel>(EXPRESSION_CHANNELS[command.expression]);
    if (channels.has('shape')) mixShape(eyes, pose, weight);
    if (channels.has('lids')) {
      leftLid = mix(leftLid, pose.leftLid, weight);
      rightLid = mix(rightLid, pose.rightLid, weight);
    }
    if (channels.has('gaze')) {
      if (pose.gazeOverrideX !== null) gazeOverrideX = mix(gazeOverrideX ?? 0, pose.gazeOverrideX, weight);
      if (pose.gazeOverrideY !== null) gazeOverrideY = mix(gazeOverrideY ?? 0, pose.gazeOverrideY, weight);
    }
    if (channels.has('nod')) nodAdd = mix(nodAdd, pose.nod, weight);
    if (channels.has('lean')) leanAdd = mix(leanAdd, pose.lean, weight);
    if (channels.has('blink')) blinkIntervalScale *= mix(1, pose.blinkIntervalScale, weight);
    if (weight >= commandWeight) {
      commandName = command.expression;
      expression = command.expression;
    }
    commandWeight = Math.max(commandWeight, weight);
  }

  // Floors go last: a command must not close the eyes distress just opened.
  if (distress) {
    eyes.height = Math.max(eyes.height, DISTRESS_EYE_HEIGHT);
    leftLid = 1;
    rightLid = 1;
    blinkIntervalScale = Math.min(blinkIntervalScale, DISTRESS_BLINK_SCALE);
    leanAdd = Math.max(leanAdd, DISTRESS_LEAN);
  }

  if (!commandName) {
    if (distress) expression = 'concerned';
    else if ((input.affect?.alertness ?? 1) < SLEEPY_ALERTNESS) expression = 'sleepy';
    else if ((input.affect?.alertness ?? 0) > 0.84) expression = 'perk_up';
  }

  clampTalkShape(eyes);
  return {
    eyes,
    leftLid,
    rightLid,
    gazeOverrideX,
    gazeOverrideY,
    nodAdd: softKneeSigned(nodAdd, 0.7),
    leanAdd: softKneeSigned(leanAdd, 0.55),
    blinkIntervalScale,
    expression,
    mood,
    // Only once the look is actually established, so the silhouette does not
    // pop in on the first frame of a crossfade.
    shape:
      commandName && commandWeight > 0.5
        ? EXPRESSION_POSES[commandName].shape ?? 'capsule'
        : 'capsule',
    commandName,
    commandWeight,
    distress,
    talkActive,
  };
}

function clampTalkShape(eyes: EyeTalkShape): void {
  eyes.width = clampRange(eyes.width, 18, 34);
  eyes.height = clampRange(eyes.height, 16, 78);
  eyes.spacing = clampRange(eyes.spacing, 50, 88);
  eyes.offsetY = clampRange(eyes.offsetY, -48, -18);
  eyes.leftHeightMult = clampRange(eyes.leftHeightMult, 0.35, 1.22);
  eyes.rightHeightMult = clampRange(eyes.rightHeightMult, 0.35, 1.22);
  eyes.radius = clampRange(eyes.radius, 8, 16);
}

function clampRange(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function softKneeSigned(value: number, limit: number): number {
  if (!Number.isFinite(value) || limit <= 0) return 0;
  return limit * Math.tanh(value / limit);
}

function applyAffect(eyes: EyeTalkShape, affect: AffectLevels | null | undefined, distress: boolean): void {
  if (!affect) return;
  const alert = affect.alertness;
  const drowsy = distress ? 0 : 1 - alert;
  eyes.height += (alert - 0.55) * 8 - drowsy * 10;
  eyes.offsetY += drowsy * 4;
  eyes.leftHeightMult = mix(eyes.leftHeightMult, 0.45, drowsy * 0.45);
  eyes.rightHeightMult = mix(eyes.rightHeightMult, 0.45, drowsy * 0.45);
  eyes.spacing += (affect.engagement - 0.5) * 5;
  eyes.width += affect.warmth * 1.4;
  eyes.angle += affect.strain * -2;
  eyes.height -= affect.strain * 4;
  clampTalkShape(eyes);
}

/** One line of reading: a slow sweep across, then a quick return and a small drop. */
export const READING_LINE_MS = 900;
const READING_SWEEP = 0.85;

/** Gaze while reading, `elapsedMs` into the look. Stays within the gaze range (±12, ±10). */
export function readingGaze(elapsedMs: number): { x: number; y: number } {
  const t = Math.max(0, elapsedMs);
  const line = Math.floor(t / READING_LINE_MS);
  const within = (t % READING_LINE_MS) / READING_LINE_MS;
  const eased = within < READING_SWEEP ? within / READING_SWEEP : 1 - (within - READING_SWEEP) / (1 - READING_SWEEP);
  return { x: -9 + eased * 18, y: 1 + (line % 4) * 2.2 };
}

function animatedCommandPose(command: ActiveExpression, now: number) {
  const pose = { ...EXPRESSION_POSES[command.expression] };
  if (command.expression === 'roll_eyes') {
    const phase = ((now - command.startedAt) / Math.max(1, command.durationMs)) * Math.PI * 2;
    pose.gazeOverrideX = Math.cos(phase) * 10;
    pose.gazeOverrideY = Math.sin(phase) * 8;
  }
  if (command.expression === 'thinking') {
    // A slow wander around the up-and-aside spot, the way eyes rest while thinking.
    const t = (now - command.startedAt) / 1000;
    pose.gazeOverrideX = 8 + Math.sin(t * 0.9) * 2.5;
    pose.gazeOverrideY = -8 + Math.cos(t * 0.7) * 1.5;
  }
  if (command.expression === 'reading') {
    const { x, y } = readingGaze(now - command.startedAt);
    pose.gazeOverrideX = x;
    pose.gazeOverrideY = y;
  }
  if (command.expression === 'wink') {
    const local = (now - command.startedAt) / Math.max(1, command.durationMs);
    pose.leftLid = local < 0.55 ? 0.04 : mix(0.04, 1, (local - 0.55) / 0.45);
  }
  return pose;
}

function mixShape(target: EyeTalkShape, pose: { [K in keyof EyeTalkShape]?: number }, t: number): void {
  target.width = mix(target.width, pose.width ?? target.width, t);
  target.height = mix(target.height, pose.height ?? target.height, t);
  target.spacing = mix(target.spacing, pose.spacing ?? target.spacing, t);
  target.angle = mix(target.angle, pose.angle ?? target.angle, t);
  target.radius = mix(target.radius, pose.radius ?? target.radius, t);
  target.offsetY = mix(target.offsetY, pose.offsetY ?? target.offsetY, t);
  target.leftHeightMult = mix(target.leftHeightMult, pose.leftHeightMult ?? target.leftHeightMult, t);
  target.rightHeightMult = mix(target.rightHeightMult, pose.rightHeightMult ?? target.rightHeightMult, t);
  target.leftAngleAdd = mix(target.leftAngleAdd, pose.leftAngleAdd ?? target.leftAngleAdd, t);
  target.rightAngleAdd = mix(target.rightAngleAdd, pose.rightAngleAdd ?? target.rightAngleAdd, t);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
