import React, { useEffect, useRef } from 'react';
import {
  HTML_EYE,
  HTML_GAZE_DAMPING,
  HTML_GAZE_STIFFNESS,
  HTML_ORB_RADIUS_REF,
  HTML_PULSE_DAMPING,
  HTML_PULSE_STIFFNESS,
  SpringValue,
  htmlGazeTarget,
} from '../../voice/face/gaze.ts';
import { EyeMorph, type MorphShape } from '../../voice/face/eyeMorph.ts';
import { lerpStop, personaPalette, personaPaletteForAffect, rgb } from '../../voice/face/personaColor.ts';
import { blendFaceLayers } from '../../voice/face/faceBlend.ts';
import type { GestureState } from '../../voice/face/gesture.ts';
import type { EyeTalkShape, TalkCue } from '../../voice/face/eyeTalk.ts';
import { CueLock, PoseMixer, SLEW_PER_FRAME, slewForDt, slewLimit } from '../../voice/face/motion.ts';
import {
  ORB_BASE_RADIUS,
  clampMeshDistortion,
  clampRadius,
  layoutEyesInOrb,
} from '../../voice/face/layout.ts';
import { EnvelopeFollower } from '../../voice/face/energy.ts';
import { gazeBackchannelSaccade } from '../../voice/face/backchannel.ts';
import { nodOffset } from '../../voice/face/listenerReaction.ts';

interface LiveOrbFaceProps {
  voiceId: string;
  /**
   * Pulled once per animation frame rather than passed as a prop. The gesture is
   * derived from mic energy that updates ~50x/second; as a prop it forced a React
   * render per capture frame for a canvas that already runs its own rAF loop.
   */
  getGesture: () => GestureState;
  reducedMotion: boolean;
}

const CSS_SIZE = 280;
const EYE_SPRING_K = 0.22;
const EYE_SPRING_D = 0.62;
const LID_SPRING_K = 0.32;
const LID_SPRING_D = 0.55;
const NOD_SPRING_K = 0.14;
const NOD_SPRING_D = 0.72;

export const LiveOrbFace: React.FC<LiveOrbFaceProps> = ({ voiceId, getGesture, reducedMotion }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const getGestureRef = useRef(getGesture);
  getGestureRef.current = getGesture;
  // Snapshot for this frame. Every read inside one draw sees the same gesture.
  const gestureRef = useRef<GestureState>(getGesture());
  const voiceRef = useRef(voiceId);
  voiceRef.current = voiceId;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let blinkRaf = 0;
    let time = 0;
    let lastTs = 0;
    const morph = new EyeMorph();
    let meshRotation = 0;
    let blinkValue = 1;
    let blinkValueRight = 1;
    let blinking = false;
    let blinkTimer: ReturnType<typeof setTimeout> | null = null;
    let lastBcAt = 0;
    let saccadeUntil = 0;
    let saccadeX = 0;
    let saccadeY = 0;
    let lastJump = 0;
    const poseMixer = new PoseMixer();
    const cueLock = new CueLock<TalkCue>('idle');
    const userEnv = new EnvelopeFollower(0.4, 0.16);
    const playEnv = new EnvelopeFollower(0.32, 0.12);
    let stops = personaPalette(voiceRef.current).stops.map((stop) => ({ ...stop }));
    const gazeX = new SpringValue(0, HTML_GAZE_STIFFNESS, HTML_GAZE_DAMPING);
    const gazeY = new SpringValue(0, HTML_GAZE_STIFFNESS, HTML_GAZE_DAMPING);
    const orbPulse = new SpringValue(0, HTML_PULSE_STIFFNESS, HTML_PULSE_DAMPING);
    const nodSpring = new SpringValue(0, NOD_SPRING_K, NOD_SPRING_D);
    const leanSpring = new SpringValue(0, NOD_SPRING_K, NOD_SPRING_D);
    const eyeSprings = {
      width: new SpringValue(HTML_EYE.width, EYE_SPRING_K, EYE_SPRING_D),
      height: new SpringValue(HTML_EYE.height, EYE_SPRING_K, EYE_SPRING_D),
      spacing: new SpringValue(HTML_EYE.spacing, EYE_SPRING_K, EYE_SPRING_D),
      angle: new SpringValue(0, EYE_SPRING_K, EYE_SPRING_D),
      radius: new SpringValue(HTML_EYE.radius, EYE_SPRING_K, EYE_SPRING_D),
      offsetY: new SpringValue(HTML_EYE.offsetY, EYE_SPRING_K, EYE_SPRING_D),
      leftHeightMult: new SpringValue(1, EYE_SPRING_K, EYE_SPRING_D),
      rightHeightMult: new SpringValue(1, EYE_SPRING_K, EYE_SPRING_D),
      leftAngleAdd: new SpringValue(0, EYE_SPRING_K, EYE_SPRING_D),
      rightAngleAdd: new SpringValue(0, EYE_SPRING_K, EYE_SPRING_D),
    };
    const leftLidSpring = new SpringValue(1, LID_SPRING_K, LID_SPRING_D);
    const rightLidSpring = new SpringValue(1, LID_SPRING_K, LID_SPRING_D);
    const mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

    const onMouseMove = (event: MouseEvent) => {
      mouse.x = event.clientX;
      mouse.y = event.clientY;
    };
    window.addEventListener('mousemove', onMouseMove);

    const triggerBlink = (duration = 150) => {
      if (blinking || reducedMotion) return;
      blinking = true;
      const startTime = performance.now();
      const step = (now: number) => {
        const progress = (now - startTime) / duration;
        const rightProgress = (now - startTime - 40) / duration;
        const lid = (p: number) => {
          if (p < 0) return 1;
          if (p < 0.5) return 1 - p * 2;
          if (p <= 1) return (p - 0.5) * 2;
          return 1;
        };
        blinkValue = lid(progress);
        blinkValueRight = lid(rightProgress);
        if (progress > 1 && rightProgress > 1) {
          blinkValue = 1;
          blinkValueRight = 1;
          blinking = false;
          return;
        }
        blinkRaf = window.requestAnimationFrame(step);
      };
      blinkRaf = window.requestAnimationFrame(step);
    };

    const scheduleNextBlink = () => {
      if (reducedMotion) return;
      const face = liveFace(gestureRef.current);
      const modelLive = gestureRef.current.play > 0.05 || gestureRef.current.pose === 'speaking';
      const userLive = !modelLive && gestureRef.current.user > 0.05;
      let delay = (Math.random() * 4000 + 3000) * face.blinkIntervalScale;
      const alertness = gestureRef.current.affect?.alertness ?? 0.62;
      delay *= 1.35 - alertness * 0.55;
      if (face.expression === 'curious' || gestureRef.current.eyes.cue === 'question') delay = Math.random() * 4000 + 8000;
      else if (userLive) delay = Math.random() * 1800 + 1400;
      else if (modelLive) delay = Math.random() * 4000 + 6000;
      blinkTimer = setTimeout(() => {
        const next = liveFace(gestureRef.current);
        if (next.expression !== 'curious' && gestureRef.current.eyes.cue !== 'question') triggerBlink();
        scheduleNextBlink();
      }, delay);
    };
    scheduleNextBlink();

    const aimEyes = (eyes: EyeTalkShape, dtMs: number) => {
      eyeSprings.width.set(slewLimit(eyeSprings.width.current, eyes.width, slewForDt(SLEW_PER_FRAME.width, dtMs)));
      eyeSprings.height.set(slewLimit(eyeSprings.height.current, eyes.height, slewForDt(SLEW_PER_FRAME.height, dtMs)));
      eyeSprings.spacing.set(slewLimit(eyeSprings.spacing.current, eyes.spacing, slewForDt(SLEW_PER_FRAME.spacing, dtMs)));
      eyeSprings.angle.set(eyes.angle);
      eyeSprings.radius.set(eyes.radius);
      eyeSprings.offsetY.set(slewLimit(eyeSprings.offsetY.current, eyes.offsetY, slewForDt(SLEW_PER_FRAME.offsetY, dtMs)));
      eyeSprings.leftHeightMult.set(eyes.leftHeightMult);
      eyeSprings.rightHeightMult.set(eyes.rightHeightMult);
      eyeSprings.leftAngleAdd.set(eyes.leftAngleAdd);
      eyeSprings.rightAngleAdd.set(eyes.rightAngleAdd);
      Object.values(eyeSprings).forEach((spring) => spring.update(dtMs));
    };

    const draw = (ts: number) => {
      const dtMs = lastTs ? Math.min(48, Math.max(8, ts - lastTs)) : 16.67;
      lastTs = ts;
      // Sample the live presence frame once, at display rate.
      gestureRef.current = getGestureRef.current();
      const g = gestureRef.current;
      const face = liveFace(g);
      morph.update(face.shape as MorphShape, dtMs, reducedMotion);
      const heldCue = cueLock.hold(face.eyes.cue, ts, 180);
      const target = personaPaletteForAffect(personaPalette(voiceRef.current), g.affect).stops;
      const ease = reducedMotion ? 1 : 1 - Math.exp((-dtMs / 16.67) * 0.12);
      stops = stops.map((stop, index) => lerpStop(stop, target[index] || target[0], ease));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== CSS_SIZE * dpr) {
        canvas.width = CSS_SIZE * dpr;
        canvas.height = CSS_SIZE * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      ctx.clearRect(0, 0, CSS_SIZE, CSS_SIZE);

      time += reducedMotion ? 0 : dtMs * 0.0009;
      const alert = g.affect?.alertness ?? 0.62;
      const engage = g.affect?.engagement ?? 0.58;
      poseMixer.tick(g.pose, dtMs, g.pose === 'crisis' ? 0 : 280);
      const user = userEnv.push(g.user, dtMs);
      const play = playEnv.push(g.play, dtMs);
      const pulseTarget =
        reducedMotion || g.pose === 'crisis'
          ? 0
          : slewLimit(orbPulse.current, g.beat || Math.max(user, play), slewForDt(SLEW_PER_FRAME.pulse, dtMs));
      orbPulse.set(pulseTarget);
      orbPulse.update(dtMs);
      const pulseVal = reducedMotion || g.pose === 'crisis' ? 0 : Math.max(0, Math.min(1, orbPulse.current));
      meshRotation += reducedMotion ? 0 : (0.005 + pulseVal * 0.02) * (dtMs / 16.67);
      const breathRate = 0.7 + alert * 0.35;
      const breath = reducedMotion || g.pose === 'crisis' ? 0 : Math.sin(time * breathRate) * (1.2 + (1 - alert) * 0.8);
      const radius = clampRadius(ORB_BASE_RADIUS, pulseVal, breath);
      const scale = radius / HTML_ORB_RADIUS_REF;
      const floatY = reducedMotion || g.pose === 'crisis' ? 0 : Math.sin(time * 1.2) * 4;
      const cx = CSS_SIZE / 2;
      const cy = CSS_SIZE / 2 + floatY;

      const cue = g.backchannel;
      if (cue && cue.at !== lastBcAt && !reducedMotion && g.pose !== 'crisis') {
        lastBcAt = cue.at;
        if (cue.kind === 'blink') triggerBlink(130);
        if (cue.kind === 'gaze') {
          const saccade = gazeBackchannelSaccade(cue.strength);
          saccadeX = saccade.x;
          saccadeY = saccade.y;
          saccadeUntil = performance.now() + saccade.holdMs;
        }
      }

      nodSpring.set(slewLimit(nodSpring.current, g.nod, slewForDt(SLEW_PER_FRAME.nod, dtMs)));
      leanSpring.set(slewLimit(leanSpring.current, g.lean, slewForDt(SLEW_PER_FRAME.lean, dtMs)));
      nodSpring.update(dtMs);
      leanSpring.update(dtMs);

      if (reducedMotion || g.pose === 'crisis') {
        gazeX.snap(0);
        gazeY.snap(0);
        nodSpring.snap(0);
        leanSpring.snap(0);
        eyeSprings.width.snap(HTML_EYE.width);
        eyeSprings.height.snap(HTML_EYE.height);
        eyeSprings.spacing.snap(HTML_EYE.spacing);
        eyeSprings.angle.snap(0);
        eyeSprings.radius.snap(HTML_EYE.radius);
        eyeSprings.offsetY.snap(HTML_EYE.offsetY);
        eyeSprings.leftHeightMult.snap(1);
        eyeSprings.rightHeightMult.snap(1);
        eyeSprings.leftAngleAdd.snap(0);
        eyeSprings.rightAngleAdd.snap(0);
        const winkNow = reducedMotion && face.commandName === 'wink' && face.commandWeight > 0.35;
        leftLidSpring.snap(winkNow ? 0.05 : 1);
        rightLidSpring.snap(1);
      } else {
        aimEyes(face.eyes, dtMs);
        leftLidSpring.set(face.leftLid);
        rightLidSpring.set(face.rightLid);
        leftLidSpring.update(dtMs);
        rightLidSpring.update(dtMs);
        const box = canvas.getBoundingClientRect();
        const originX = box.left + box.width / 2;
        const originY = box.top + box.height / 2;
        const look = htmlGazeTarget(mouse.x, mouse.y, originX, originY, window.innerWidth, window.innerHeight);
        if (!reducedMotion && performance.now() > saccadeUntil && Math.random() < 0.006 + alert * engage * 0.012) {
          saccadeX = (Math.random() - 0.5) * 6;
          saccadeY = (Math.random() - 0.5) * 4;
          saccadeUntil = performance.now() + 140;
        }
        if (performance.now() > saccadeUntil) {
          saccadeX *= 0.82;
          saccadeY *= 0.82;
        }
        const holdDriftX = poseMixer.weights.holding * Math.sin(time * 0.45) * 5;
        const holdDriftY = poseMixer.weights.holding * Math.cos(time * 0.32) * 3;
        const drowsyDriftX = face.gazeOverrideX === null ? Math.sin(time * 0.28) * (1 - alert) * 3.5 : 0;
        const drowsyDriftY = face.gazeOverrideY === null ? Math.cos(time * 0.22) * (1 - alert) * 2.2 : 0;
        const gazeTargetX =
          face.gazeOverrideX !== null
            ? face.gazeOverrideX
            : look.x + face.eyes.gazeNudgeX + saccadeX + holdDriftX + drowsyDriftX;
        const gazeTargetY =
          face.gazeOverrideY !== null
            ? face.gazeOverrideY
            : look.y + face.eyes.gazeNudgeY + saccadeY + holdDriftY + drowsyDriftY;
        gazeX.set(slewLimit(gazeX.current, gazeTargetX, slewForDt(SLEW_PER_FRAME.gaze, dtMs)));
        gazeY.set(slewLimit(gazeY.current, gazeTargetY, slewForDt(SLEW_PER_FRAME.gaze, dtMs)));
        gazeX.update(dtMs);
        gazeY.update(dtMs);
      }

      ctx.save();
      ctx.translate(cx, cy);

      const bloom = ctx.createRadialGradient(0, 0, radius * 0.4, 0, 0, radius * 1.6);
      bloom.addColorStop(0, rgb(stops[1], 0.22 + pulseVal * 0.16));
      bloom.addColorStop(1, rgb(stops[0], 0));
      ctx.fillStyle = bloom;
      ctx.beginPath();
      ctx.arc(0, 0, radius * 1.6, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      const points = 120;
      const distortionAmp = reducedMotion ? 0 : clampMeshDistortion(radius, pulseVal);
      for (let i = 0; i <= points; i += 1) {
        const angle = (i / points) * Math.PI * 2;
        const distortion = reducedMotion
          ? 0
          : Math.sin(angle * 3 + time * 2) * distortionAmp + Math.cos(angle * 5 - time * 1.5) * distortionAmp * 0.7;
        const r = radius + distortion;
        const x = Math.cos(angle) * r;
        const y = Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      const gx1 = Math.cos(meshRotation) * radius * 0.9;
      const gy1 = Math.sin(meshRotation) * radius * 0.9;
      const grad = ctx.createLinearGradient(gx1, gy1, -gx1, -gy1);
      grad.addColorStop(0, rgb(stops[0]));
      grad.addColorStop(0.5, rgb(stops[1]));
      grad.addColorStop(1, rgb(stops[2]));
      ctx.fillStyle = grad;
      ctx.fill();

      const nodeX = reducedMotion ? radius * 0.18 : Math.cos(time * 0.9) * radius * 0.3;
      const nodeY = reducedMotion ? -radius * 0.16 : Math.sin(time * 0.8) * radius * 0.3;
      const swirl = ctx.createRadialGradient(nodeX, nodeY, 0, nodeX, nodeY, radius * 0.85);
      swirl.addColorStop(0, rgb(stops[2], 0.75));
      swirl.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = swirl;
      ctx.fill();

      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
      core.addColorStop(0, 'rgba(255, 255, 255, 0.25)');
      core.addColorStop(0.5, 'rgba(255, 255, 255, 0.05)');
      core.addColorStop(1, 'rgba(0, 0, 0, 0.15)');
      ctx.fillStyle = core;
      ctx.fill();
      ctx.restore();

      const layout = layoutEyesInOrb({
        radius,
        cx,
        cy,
        width: Math.max(3, eyeSprings.width.current * scale),
        height: Math.max(3, eyeSprings.height.current * scale),
        spacing: eyeSprings.spacing.current * scale,
        offsetY: eyeSprings.offsetY.current * scale,
        leftHeightMult: eyeSprings.leftHeightMult.current,
        rightHeightMult: eyeSprings.rightHeightMult.current,
        corner: eyeSprings.radius.current * scale,
        gazeX: gazeX.current,
        gazeY: gazeY.current,
        // The reaction is a timed curve on top of the sprung nod: springs and slew
        // limits would smooth a quick 'yeah' nod away into nothing.
        nod: nodSpring.current + (reducedMotion || g.pose === 'crisis' ? 0 : nodOffset(g.reaction, Date.now()) * 0.9),
        lean: leanSpring.current,
        pulse: pulseVal,
        scale,
      });
      const leftBlink = reducedMotion
        ? Math.max(0.02, Math.min(1, leftLidSpring.current))
        : Math.max(0.02, Math.min(1, blinkValue * leftLidSpring.current));
      const rightBlink = reducedMotion
        ? Math.max(0.02, Math.min(1, rightLidSpring.current))
        : Math.max(0.02, Math.min(1, blinkValueRight * rightLidSpring.current));
      const leftAngle = eyeSprings.angle.current + eyeSprings.leftAngleAdd.current;
      const rightAngle = -eyeSprings.angle.current + eyeSprings.rightAngleAdd.current;
      // A look can carry its own silhouette, and the eye morphs into it (and
      // back) instead of swapping outlines. Blink scale, rotation and gaze are
      // unchanged, so a shaped eye still blinks and tracks like a normal one.
      const eyePoints = (w: number, h: number) => morph.points(w, h, layout.corner);
      // Joy moves: a laugh bobs the eyes, sparkles twinkle. Timed off the wall
      // clock so it keeps its rhythm whatever the frame rate.
      const joy = reducedMotion ? 0 : face.commandWeight;
      const clockS = Date.now() / 1000;
      const bob = face.commandName === 'laugh' ? Math.abs(Math.sin(clockS * Math.PI * 4.2)) * -3.2 * joy * scale : 0;
      const twinkle = face.commandName === 'excited' ? 1 + 0.09 * Math.sin(clockS * Math.PI * 3) * joy : 1;
      // Arcs are closed eyes: they do not blink shut again. Faded by how much of
      // the arc is showing, so the blink hands over as the eye morphs.
      const arcShown = morph.weight('arc');
      const lb = leftBlink + (1 - leftBlink) * arcShown;
      const rb = rightBlink + (1 - rightBlink) * arcShown;
      // Cheeks glow in and out with the blush itself (no threshold pop).
      if (face.commandName === 'blush' && face.commandWeight > 0.01) {
        drawCheeks(ctx, layout, radius, scale, Math.min(1, face.commandWeight));
      }
      drawPolyEye(ctx, layout.left.x, layout.left.y + bob, eyePoints(layout.left.w * twinkle, layout.left.h * twinkle), lb, leftAngle);
      drawPolyEye(ctx, layout.right.x, layout.right.y + bob, eyePoints(layout.right.w * twinkle, layout.right.h * twinkle), rb, rightAngle);

      const jump = Math.max(
        Math.abs(nodSpring.current - (Number(canvas.dataset.nod) || 0)),
        Math.abs(layout.left.h - (Number(canvas.dataset.eyePx) || layout.left.h)),
      );
      lastJump = Math.max(lastJump * 0.98, jump);

      canvas.dataset.gazeX = String(gazeX.current.toFixed(2));
      canvas.dataset.gazeY = String(gazeY.current.toFixed(2));
      canvas.dataset.cue = heldCue;
      canvas.dataset.role = g.speech.role;
      canvas.dataset.talk = face.talkActive ? '1' : '0';
      canvas.dataset.play = String(g.play.toFixed(3));
      canvas.dataset.user = String(g.user.toFixed(3));
      canvas.dataset.eyeH = String(eyeSprings.height.current.toFixed(1));
      canvas.dataset.eyePx = String(layout.left.h.toFixed(1));
      canvas.dataset.lidL = String(Math.max(0, Math.min(1, leftLidSpring.current)).toFixed(3));
      canvas.dataset.lidR = String(Math.max(0, Math.min(1, rightLidSpring.current)).toFixed(3));
      canvas.dataset.expr = String(face.expression);
      canvas.dataset.mood = String(face.mood);
      canvas.dataset.cmd = face.commandName || '';
      canvas.dataset.alert = g.affect ? g.affect.alertness.toFixed(3) : '';
      canvas.dataset.engage = g.affect ? g.affect.engagement.toFixed(3) : '';
      canvas.dataset.strain = g.affect ? g.affect.strain.toFixed(3) : '';
      canvas.dataset.warm = g.affect ? g.affect.warmth.toFixed(3) : '';
      canvas.dataset.clipped = layout.clipped ? '1' : '0';
      canvas.dataset.nod = String(nodSpring.current.toFixed(3));
      canvas.dataset.jump = String(lastJump.toFixed(3));
      canvas.dataset.bc = cue?.kind || '';

      raf = window.requestAnimationFrame(draw);
    };

    raf = window.requestAnimationFrame(draw);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      if (blinkTimer !== null) clearTimeout(blinkTimer);
      window.cancelAnimationFrame(raf);
      window.cancelAnimationFrame(blinkRaf);
    };
  }, [reducedMotion]);

  return (
    <canvas
      ref={canvasRef}
      data-live-gaze="html"
      className="w-[280px] h-[280px] pointer-events-none"
      aria-hidden="true"
    />
  );
};

function liveFace(gesture: GestureState) {
  return blendFaceLayers({
    speech: gesture.speech,
    prosody: gesture.prosody,
    command: gesture.command,
    commands: gesture.commands,
    affect: gesture.affect,
    userTranscript: gesture.userTranscript,
    crisis: gesture.crisis,
    now: Date.now(),
  });
}

/** Soft pink cheeks under the eyes, for a blush. */
function drawCheeks(
  ctx: CanvasRenderingContext2D,
  layout: { left: { x: number; y: number; w: number }; right: { x: number; y: number; w: number } },
  radius: number,
  scale: number,
  alpha: number,
): void {
  const r = Math.max(8, radius * 0.2);
  for (const eye of [layout.left, layout.right]) {
    const x = eye.x + (eye === layout.left ? -eye.w * 0.6 : eye.w * 0.6);
    const y = eye.y + 30 * scale;
    const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
    glow.addColorStop(0, `rgba(255, 110, 150, ${0.75 * alpha})`);
    glow.addColorStop(1, 'rgba(255, 120, 160, 0)');
    ctx.save();
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.35, r * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawPolyEye(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  pts: Array<{ x: number; y: number }>,
  blinkScale: number,
  angleDeg = 0,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((angleDeg * Math.PI) / 180);
  ctx.scale(1, blinkScale);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i += 1) {
    ctx.lineTo(pts[i].x, pts[i].y);
  }
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(255, 255, 255, 0.9)';
  ctx.shadowBlur = 10;
  ctx.fill();
  ctx.restore();
}
