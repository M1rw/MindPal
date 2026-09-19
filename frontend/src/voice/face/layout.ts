/**
 * Hard geometric clamps. Eyes, lids, and pulse distortion stay inside the orb.
 */

import { capsuleEyePoints, HTML_EYE } from './gaze.ts';
import { softKnee } from './energy.ts';

export const ORB_BASE_RADIUS = 78;
export const ORB_INSET = 0.92;

export const ORB_SAFE = {
  maxEyeHeightFrac: 0.4,
  maxEyeWidthFrac: 0.2,
  maxSpacingFrac: 0.7,
  maxOffsetYFrac: 0.36,
  maxPairOffsetFrac: 0.4,
  maxNodFrac: 0.075,
  maxLeanFrac: 0.09,
  maxPulseFrac: 0.14,
  maxDistortionFrac: 0.055,
  maxGaze: 12,
} as const;

export interface EyePairInput {
  radius: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
  spacing: number;
  offsetY: number;
  leftHeightMult: number;
  rightHeightMult: number;
  corner: number;
  gazeX: number;
  gazeY: number;
  nod: number;
  lean: number;
  pulse: number;
  scale: number;
}

export interface EyeSlot {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OrbEyeLayout {
  radius: number;
  cx: number;
  cy: number;
  left: EyeSlot;
  right: EyeSlot;
  corner: number;
  clipped: boolean;
}

export function clampRadius(base: number, pulse: number, breath: number): number {
  const pulseTravel = Math.max(0, pulse) * base * ORB_SAFE.maxPulseFrac;
  const breathTravel = Math.max(-base * 0.04, Math.min(base * 0.04, breath));
  return base + pulseTravel + breathTravel;
}

export function clampMeshDistortion(radius: number, pulse: number): number {
  return Math.min(radius * ORB_SAFE.maxDistortionFrac, 1.6 + Math.max(0, pulse) * 3.2);
}

/**
 * One NaN reaching the geometry used to blank the face for the rest of the call,
 * so every channel falls back to the neutral HTML pose instead.
 */
function sanitizeEyePair(input: EyePairInput): EyePairInput {
  return {
    radius: finite(input.radius, ORB_BASE_RADIUS),
    cx: finite(input.cx, 0),
    cy: finite(input.cy, 0),
    width: finite(input.width, HTML_EYE.width),
    height: finite(input.height, HTML_EYE.height),
    spacing: finite(input.spacing, HTML_EYE.spacing),
    offsetY: finite(input.offsetY, HTML_EYE.offsetY),
    leftHeightMult: finite(input.leftHeightMult, 1),
    rightHeightMult: finite(input.rightHeightMult, 1),
    corner: finite(input.corner, HTML_EYE.radius),
    gazeX: finite(input.gazeX, 0),
    gazeY: finite(input.gazeY, 0),
    nod: finite(input.nod, 0),
    lean: finite(input.lean, 0),
    pulse: finite(input.pulse, 0),
    scale: finite(input.scale, 1),
  };
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function layoutEyesInOrb(raw: EyePairInput): OrbEyeLayout {
  const input = sanitizeEyePair(raw);
  const radius = Math.max(8, input.radius);
  const scale = Math.max(0.01, input.scale);
  const maxH = radius * ORB_SAFE.maxEyeHeightFrac;
  const maxW = radius * ORB_SAFE.maxEyeWidthFrac;
  const maxSpacing = radius * ORB_SAFE.maxSpacingFrac;
  const width = Math.max(3, Math.min(maxW, input.width));
  const height = Math.max(3, Math.min(maxH, input.height));
  const leftMult = Math.max(0.35, Math.min(1.22, input.leftHeightMult));
  const rightMult = Math.max(0.35, Math.min(1.22, input.rightHeightMult));
  let leftH = Math.max(3, Math.min(maxH, height * leftMult));
  let rightH = Math.max(3, Math.min(maxH, height * rightMult));
  const spacing = Math.max(width + 4, Math.min(maxSpacing, input.spacing));
  const nodPx = softKnee(input.nod, 1) * radius * ORB_SAFE.maxNodFrac;
  const leanPx = softKnee(input.lean, 1) * radius * ORB_SAFE.maxLeanFrac;
  const gazeX = Math.max(-ORB_SAFE.maxGaze, Math.min(ORB_SAFE.maxGaze, input.gazeX)) * scale;
  const gazeY = Math.max(-ORB_SAFE.maxGaze, Math.min(ORB_SAFE.maxGaze, input.gazeY)) * scale;
  const offsetY = Math.max(-radius * ORB_SAFE.maxOffsetYFrac, Math.min(radius * 0.08, input.offsetY));
  let pairX = input.cx + gazeX + leanPx;
  let pairY = input.cy + offsetY + gazeY + nodPx;
  const maxPair = radius * ORB_SAFE.maxPairOffsetFrac;
  const pairDist = Math.hypot(pairX - input.cx, pairY - input.cy);
  let clipped = pairDist > maxPair;
  if (pairDist > maxPair) {
    const angle = Math.atan2(pairY - input.cy, pairX - input.cx);
    pairX = input.cx + Math.cos(angle) * maxPair;
    pairY = input.cy + Math.sin(angle) * maxPair;
  }

  const left: EyeSlot = { x: pairX - spacing / 2, y: pairY, w: width, h: leftH };
  const right: EyeSlot = { x: pairX + spacing / 2, y: pairY, w: width, h: rightH };
  const leftFit = fitEyeInOrb(left, input.cx, input.cy, radius);
  const rightFit = fitEyeInOrb(right, input.cx, input.cy, radius);
  clipped = clipped || leftFit.clipped || rightFit.clipped;
  return {
    radius,
    cx: input.cx,
    cy: input.cy,
    left: leftFit.slot,
    right: rightFit.slot,
    corner: Math.max(0.8, Math.min(width / 2, leftFit.slot.h / 2, input.corner)),
    clipped,
  };
}

export function eyeExtentOutsideOrb(
  slot: EyeSlot,
  cx: number,
  cy: number,
  radius: number,
): number {
  const halfW = slot.w / 2;
  const halfH = slot.h / 2;
  const corners = [
    [slot.x - halfW, slot.y - halfH],
    [slot.x + halfW, slot.y - halfH],
    [slot.x - halfW, slot.y + halfH],
    [slot.x + halfW, slot.y + halfH],
  ];
  let overflow = 0;
  for (const [x, y] of corners) {
    overflow = Math.max(overflow, Math.hypot(x - cx, y - cy) - radius * ORB_INSET);
  }
  return overflow;
}

function fitEyeInOrb(slot: EyeSlot, cx: number, cy: number, radius: number): { slot: EyeSlot; clipped: boolean } {
  const limit = radius * ORB_INSET;
  let next = { ...slot };
  let clipped = false;
  for (let i = 0; i < 8; i += 1) {
    const overflow = eyeExtentOutsideOrb(next, cx, cy, radius);
    if (overflow <= 0.25) return { slot: next, clipped };
    clipped = true;
    const shrink = Math.max(0.72, 1 - overflow / Math.max(8, next.h));
    next = {
      ...next,
      w: Math.max(3, next.w * shrink),
      h: Math.max(3, next.h * shrink),
    };
    const dist = Math.hypot(next.x - cx, next.y - cy);
    const inset = Math.max(0, dist + Math.hypot(next.w / 2, next.h / 2) - limit);
    if (inset > 0 && dist > 0.01) {
      const pull = inset / dist;
      next.x -= (next.x - cx) * pull;
      next.y -= (next.y - cy) * pull;
    }
  }
  return { slot: next, clipped: true };
}

export function layoutPoints(slot: EyeSlot, corner: number): Array<{ x: number; y: number }> {
  return capsuleEyePoints(slot.w, slot.h, corner);
}
