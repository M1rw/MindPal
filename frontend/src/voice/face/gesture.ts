import type { FloorState } from '../types.ts';
import { eyeTalkFromSpeech, type EyeTalkShape } from './eyeTalk.ts';
import { blendFaceLayers, type FaceBlendResult } from './faceBlend.ts';
import type { ActiveExpression } from './expressionCommand.ts';
import type { AffectLevels } from './affect.ts';
import type { ProsodySnapshot } from './prosody.ts';
import { softKnee } from './energy.ts';
import { type PresencePose } from './motion.ts';
import type { VisualBackchannel } from './backchannel.ts';
import type { ListenerReaction } from './listenerReaction.ts';

export type { PresencePose };

export interface GestureInput {
  floor: FloorState;
  userEnergy: number;
  playbackEnergy: number;
  playbackBrightness?: number;
  userTranscript: string;
  modelTranscript: string;
  prosody?: ProsodySnapshot | null;
  command?: ActiveExpression | null;
  commands?: ActiveExpression[] | null;
  affect?: AffectLevels | null;
  backchannel?: VisualBackchannel | null;
  reaction?: ListenerReaction | null;
  engagementBoost?: number;
  /** Latched distress from the live session. */
  distress?: boolean;
  now?: number;
}

export interface GestureState {
  pose: PresencePose;
  nod: number;
  lean: number;
  blink: number;
  beat: number;
  play: number;
  user: number;
  brightness: number;
  eyes: EyeTalkShape;
  face: FaceBlendResult;
  speech: EyeTalkShape;
  command: ActiveExpression | null;
  commands: ActiveExpression[];
  affect: AffectLevels | null;
  prosody: ProsodySnapshot | null;
  userTranscript: string;
  crisis: boolean;
  backchannel: VisualBackchannel | null;
  reaction: ListenerReaction | null;
}

function poseFromFloor(floor: FloorState): PresencePose {
  if (floor === 'crisis_freeze') return 'crisis';
  if (floor === 'holding') return 'holding';
  if (floor === 'overlapping' || floor === 'yielding') return 'yielding';
  if (floor === 'speaking') return 'speaking';
  if (floor === 'listening') return 'listening';
  return 'idle';
}

export function gestureFromDuplex(input: GestureInput, now = 0): GestureState {
  const pose = poseFromFloor(input.floor);
  const user = Math.min(1, Math.max(0, input.userEnergy));
  const play = Math.min(1, Math.max(0, input.playbackEnergy));
  const partial = pose === 'listening' && input.userTranscript.trim().length > 1;
  const frozen = pose === 'crisis';
  const modelLive = !frozen && (pose === 'speaking' || pose === 'yielding' || play > 0.05);
  const listeningReact = !frozen && !modelLive && (pose === 'listening' || user > 0.05) && (user > 0.04 || partial);
  const clock = now || input.now || Date.now();
  const speech = eyeTalkFromSpeech({
    speaking: modelLive,
    listening: listeningReact,
    modelTranscript: input.modelTranscript,
    userTranscript: input.userTranscript,
    playbackEnvelope: frozen ? 0 : play,
    userEnvelope: frozen ? 0 : user,
  });
  const commands = input.commands?.length ? input.commands : input.command ? [input.command] : [];
  const face = blendFaceLayers({
    speech,
    prosody: input.prosody,
    command: input.command,
    commands,
    affect: input.affect,
    userTranscript: input.userTranscript,
    crisis: frozen,
    distress: input.distress,
    now: clock,
  });
  const alert = input.affect?.alertness ?? 0.6;
  const moodNod = frozen ? 0 : (1 - alert) * 0.05 + (alert > 0.8 ? 0.12 : 0);
  const cue = input.backchannel;
  const cueNod = !frozen && cue?.kind === 'nod' ? cue.strength : 0;
  const cueLean = !frozen && cue?.kind === 'lean' ? cue.strength : 0;
  const longEngage = frozen ? 0 : Math.max(0, input.engagementBoost ?? 0);
  const nod = frozen
    ? 0
    : softKnee(
        (listeningReact ? Math.min(0.55, Math.max(user * 0.7, partial ? 0.22 : 0)) : modelLive ? play * 0.28 : 0) +
          face.nodAdd +
          moodNod +
          cueNod,
        0.72,
      );
  const lean = frozen
    ? 0
    : softKnee(
        (listeningReact ? Math.min(0.5, Math.max(user * 0.55, partial ? 0.18 : 0)) : pose === 'yielding' ? -0.12 : 0) +
          face.leanAdd +
          cueLean +
          longEngage * 0.35,
        0.62,
      );
  const blink = frozen
    ? 0.2
    : listeningReact
      ? 0.2 + Math.max(user, 0.08) * 0.35
      : modelLive
        ? 0.04
        : 0.08 * face.blinkIntervalScale * mixRange(1.3, 0.7, alert);
  const beat = frozen ? 0 : modelLive ? play : listeningReact ? Math.min(1, Math.max(user, partial ? 0.2 : 0)) : 0;
  const brightness = modelLive ? Math.min(1, Math.max(0, input.playbackBrightness ?? 0.5)) : 0.5;
  return {
    pose,
    nod,
    lean,
    blink,
    beat,
    play,
    user,
    brightness,
    eyes: face.eyes,
    face,
    speech,
    command: commands[commands.length - 1] ?? null,
    commands,
    affect: input.affect ?? null,
    prosody: input.prosody ?? null,
    userTranscript: input.userTranscript,
    crisis: frozen,
    backchannel: cue ?? null,
    reaction: frozen ? null : input.reaction ?? null,
  };
}

function mixRange(a: number, b: number, t: number): number {
  return a + (b - a) * Math.min(1, Math.max(0, t));
}
