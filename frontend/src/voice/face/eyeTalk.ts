/**
 * Sentence-driven eye shapes from the HTML emotion table.
 * Cues come from live transcripts + playback/mic envelope, not an emotion model.
 */

export type TalkCue =
  | 'idle'
  | 'listen'
  | 'speak'
  | 'question'
  | 'emphasis'
  | 'pause'
  | 'warmth'
  | 'concern';

export interface EyeTalkShape {
  cue: TalkCue;
  role: 'idle' | 'user' | 'model';
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
  gazeNudgeX: number;
  gazeNudgeY: number;
  leftLid: number;
  rightLid: number;
}

/** HTML EMOTIONS table — capsule geometry only. */
export const EYE_PRESETS: Record<TalkCue, Omit<EyeTalkShape, 'cue' | 'role' | 'gazeNudgeX' | 'gazeNudgeY' | 'leftLid' | 'rightLid'>> = {
  idle: {
    width: 24, height: 52, spacing: 72, angle: 0, radius: 12, offsetY: -36,
    leftHeightMult: 1, rightHeightMult: 1, leftAngleAdd: 0, rightAngleAdd: 0,
  },
  listen: {
    width: 26, height: 56, spacing: 76, angle: 0, radius: 13, offsetY: -34,
    leftHeightMult: 1.05, rightHeightMult: 1.05, leftAngleAdd: 0, rightAngleAdd: 0,
  },
  speak: {
    width: 24, height: 50, spacing: 72, angle: 0, radius: 12, offsetY: -36,
    leftHeightMult: 1, rightHeightMult: 1, leftAngleAdd: 0, rightAngleAdd: 0,
  },
  question: {
    width: 25, height: 68, spacing: 78, angle: -5, radius: 13, offsetY: -42,
    leftHeightMult: 1.1, rightHeightMult: 0.92, leftAngleAdd: -4, rightAngleAdd: -2,
  },
  emphasis: {
    width: 22, height: 34, spacing: 58, angle: 0, radius: 10, offsetY: -34,
    leftHeightMult: 1.05, rightHeightMult: 0.85, leftAngleAdd: 4, rightAngleAdd: -4,
  },
  pause: {
    width: 24, height: 22, spacing: 72, angle: 0, radius: 10, offsetY: -30,
    leftHeightMult: 0.55, rightHeightMult: 0.55, leftAngleAdd: 0, rightAngleAdd: 0,
  },
  warmth: {
    width: 28, height: 34, spacing: 76, angle: -8, radius: 14, offsetY: -36,
    leftHeightMult: 0.75, rightHeightMult: 0.75, leftAngleAdd: -4, rightAngleAdd: 4,
  },
  concern: {
    width: 26, height: 42, spacing: 70, angle: -8, radius: 13, offsetY: -28,
    leftHeightMult: 0.85, rightHeightMult: 0.85, leftAngleAdd: 2, rightAngleAdd: -2,
  },
};

const QUESTION_START =
  /^(what|why|how|when|where|who|which|do|does|did|can|could|would|will|هل|ماذا|ليه|كيف|متى|وين|شو|لماذا|أليس|ليش)\b/i;
const QUESTION_WORD = /^(what|why|how|when|where|who|which|هل|ماذا|ليه|كيف|متى|وين|شو|لماذا|ليش)\??$/i;
const EMPHASIS =
  /\b(really|very|so|never|always|just|actually|truly|جدا|جدًا|أبدا|ابدا|ضروري|فعلا|فعلاً)\b/i;
const WARMTH =
  /\b(glad|love|care|here|with you|okay|proud|nice|warm|together|haha|lol|معك|هنا|تمام|بخير|احب|أحب|لطف)\b/i;
export const CONCERN =
  /\b(hard|heavy|sorry|pain|scared|tough|difficult|worry|afraid|hurt|sad|suicide|kill myself|صعب|حزين|خايف|مؤلم|ثقيل|تعبان)\b/i;

/** Face-only concern look. Not a freeze or pause authority. */
export function hasConcernLexicon(text: string): boolean {
  return CONCERN.test(text.replace(/\s+/g, ' ').trim());
}

export function currentSpokenClause(transcript: string): string {
  const text = transcript.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const parts = text.split(/(?<=[.!?؟。])\s+/);
  return (parts[parts.length - 1] || text).trim();
}

export function lastSpokenToken(clause: string): string {
  const tokens = clause.split(/\s+/).filter(Boolean);
  return tokens[tokens.length - 1] || '';
}

export function talkCueFromSentence(clause: string, envelope = 0): TalkCue {
  const text = clause.trim();
  if (!text) return envelope > 0.12 ? 'speak' : 'idle';
  if (/[?؟]\s*$/.test(text) || QUESTION_START.test(text) || QUESTION_WORD.test(lastSpokenToken(text))) {
    return 'question';
  }
  if (/[,،]\s*$/.test(text) || /\.\.\.\s*$/.test(text) || /[—–]\s*$/.test(text)) {
    return 'pause';
  }
  if (CONCERN.test(text)) return 'concern';
  if (WARMTH.test(text)) return 'warmth';
  if (EMPHASIS.test(lastSpokenToken(text)) || EMPHASIS.test(text.slice(-28))) return 'emphasis';
  if (envelope > 0.72) return 'emphasis';
  return 'speak';
}

/** Stable gaze micro-shift from the current word so motion tracks speech, not a loop. */
export function tokenGazeNudge(token: string): { x: number; y: number } {
  const raw = token.replace(/[^\p{L}\p{N}]+/gu, '');
  if (!raw) return { x: 0, y: 0 };
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash * 33 + raw.charCodeAt(i)) | 0;
  }
  return {
    x: (Math.abs(hash) % 17) - 8,
    y: (Math.abs(hash >> 4) % 13) - 6,
  };
}

export function eyeTalkFromSpeech(input: {
  speaking: boolean;
  listening: boolean;
  modelTranscript: string;
  userTranscript: string;
  playbackEnvelope: number;
  userEnvelope: number;
}): EyeTalkShape {
  const play = Math.min(1, Math.max(0, input.playbackEnvelope));
  const user = Math.min(1, Math.max(0, input.userEnvelope));
  if (input.speaking) {
    const clause = currentSpokenClause(input.modelTranscript);
    const cue = talkCueFromSentence(clause, play);
    return shapeFromCue(cue, play, lastSpokenToken(clause), 'model');
  }
  if (input.listening) {
    const clause = currentSpokenClause(input.userTranscript);
    const raw = talkCueFromSentence(clause, user);
    const cue = raw === 'idle' || raw === 'pause' || raw === 'speak' ? 'listen' : raw;
    return shapeFromCue(cue, user, lastSpokenToken(clause), 'user');
  }
  return shapeFromCue('idle', 0, '', 'idle');
}

function shapeFromCue(
  cue: TalkCue,
  envelope: number,
  token: string,
  role: EyeTalkShape['role'],
): EyeTalkShape {
  const preset = EYE_PRESETS[cue];
  const nudge = tokenGazeNudge(token);
  const energy = envelope;
  const model = role === 'model';
  const heightBoost = model
    ? cue === 'question'
      ? energy * 10
      : cue === 'emphasis'
        ? -energy * 8
        : cue === 'pause'
          ? energy * 6
          : energy * 10
    : energy * 8;
  const pairLean = model ? 0 : energy * 4;
  return {
    cue,
    role,
    ...preset,
    width: preset.width + energy * (model ? 4 : 3),
    height: Math.max(16, Math.min(78, preset.height + heightBoost)),
    spacing: Math.max(50, Math.min(88, preset.spacing + energy * (model ? 4 : 6))),
    offsetY: Math.max(-48, Math.min(-20, preset.offsetY + (model ? energy * -4 : pairLean))),
    leftHeightMult: Math.min(1.22, preset.leftHeightMult + energy * (model ? 0.14 : 0.1)),
    rightHeightMult: Math.min(1.22, preset.rightHeightMult + energy * (model ? 0.18 : 0.08)),
    leftAngleAdd: preset.leftAngleAdd + (model ? energy * -3 : energy * 2),
    rightAngleAdd: preset.rightAngleAdd + (model ? energy * 4 : energy * -2),
    gazeNudgeX: nudge.x * Math.max(0.35, energy),
    gazeNudgeY: nudge.y * Math.max(0.35, energy) + (model ? 0 : energy * 4),
    leftLid: 1,
    rightLid: 1,
  };
}
