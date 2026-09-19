/**
 * Live-session face commands: Gemini tool calls + explicit user requests.
 * No second LLM. Expression is a side-channel and must not block audio.
 */

import {
  DISTRESS_SAFE_EXPRESSIONS,
  channelsOverlap,
  defaultDurationMs,
  isFaceExpression,
  type FaceExpression,
} from './expressionCatalog.ts';
import { isMoodState, type MoodState } from './affect.ts';

/**
 * `listener`: reacting while the caller talks. `speech`: matching MindPal's own
 * sentence. `state`: what the call is doing (thinking, reading back).
 */
export type ExpressionSource = 'tool' | 'user_request' | 'listener' | 'speech' | 'state';

export interface LiveFunctionCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ActiveExpression {
  expression: FaceExpression;
  intensity: number;
  durationMs: number;
  startedAt: number;
  source: ExpressionSource;
  supersededAt?: number;
  crossfadeMs?: number;
}

export interface MoodCommand {
  state: MoodState;
  intensity: number;
  source: ExpressionSource;
}

const USER_REQUESTS: Array<{ pattern: RegExp; expression: FaceExpression }> = [
  // Heart first, so "do a heart" cannot fall through to another look.
  // Arabic included: callers switch language mid-sentence.
  { pattern: /(draw (?:a )?heart|heart eyes?|do a heart|make a heart|shape (?:your )?eyes? into a heart|heart)|(قلب|قلوب)/i, expression: 'heart' },
  { pattern: /\b(wink|غمزة|اغمز|غمزي)\b/i, expression: 'wink' },
  { pattern: /\b(roll (?:your |ur |the )?eyes|eye[- ]?roll)\b/i, expression: 'roll_eyes' },
  { pattern: /\b(look away|look aside)\b/i, expression: 'look_away' },
  { pattern: /\b(look back|look at me)\b/i, expression: 'look_back' },
  { pattern: /\b(side[- ]eye)\b/i, expression: 'side_eye' },
  { pattern: /\b(perk up|wake up|look awake)\b/i, expression: 'perk_up' },
  { pattern: /\b(look sleepy|go to sleep|look drowsy)\b/i, expression: 'sleepy' },
  { pattern: /\b(look tired)\b/i, expression: 'tired' },
  { pattern: /\b(look surprised|surprise me)\b/i, expression: 'surprised' },
  { pattern: /\b(look curious)\b/i, expression: 'curious' },
  { pattern: /\b(look concerned)\b/i, expression: 'concerned' },
  { pattern: /\b(smile with your eyes|smile eyes)\b/i, expression: 'smile_eyes' },
  { pattern: /\b(look amused)\b/i, expression: 'amused' },
  { pattern: /\b(squint)\b/i, expression: 'squint' },
  { pattern: /\b(widen your eyes|look wide)\b/i, expression: 'widen' },
  { pattern: /\b(soften|look soft)\b/i, expression: 'soften' },
  { pattern: /\b(slow blink)\b/i, expression: 'blink_slow' },
];

export function parseFunctionCalls(raw: unknown): LiveFunctionCall[] {
  if (!raw || typeof raw !== 'object') return [];
  const record = raw as { functionCalls?: unknown; function_calls?: unknown };
  const list = record.functionCalls ?? record.function_calls;
  if (!Array.isArray(list)) return [];
  const calls: LiveFunctionCall[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { id?: unknown; name?: unknown; args?: unknown; arguments?: unknown };
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!name) continue;
    const id = typeof row.id === 'string' && row.id ? row.id : `fn-${calls.length}`;
    calls.push({ id, name, args: asArgs(row.args ?? row.arguments) });
  }
  return calls;
}

function asArgs(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

export function commandFromToolArgs(args: Record<string, unknown>, now = Date.now()): ActiveExpression | null {
  const raw = typeof args.expression === 'string' ? args.expression.trim().toLowerCase().replace(/-/g, '_') : '';
  if (!isFaceExpression(raw)) return null;
  const intensity = clamp01(typeof args.intensity === 'number' ? args.intensity : Number(args.intensity) || 1);
  const requested = Number(args.duration_ms ?? args.durationMs);
  const durationMs = Number.isFinite(requested) && requested > 80 ? Math.min(6000, requested) : defaultDurationMs(raw);
  return { expression: raw, intensity, durationMs, startedAt: now, source: 'tool' };
}

export function userFaceRequest(transcript: string): FaceExpression | null {
  const text = transcript.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  for (const row of USER_REQUESTS) {
    if (row.pattern.test(text)) return row.expression;
  }
  return null;
}

export function commandFromUserRequest(transcript: string, now = Date.now()): ActiveExpression | null {
  const expression = userFaceRequest(transcript);
  if (!expression) return null;
  return {
    expression,
    intensity: 1,
    durationMs: defaultDurationMs(expression),
    startedAt: now,
    source: 'user_request',
  };
}

export function functionResponseMessage(calls: LiveFunctionCall[], applied: boolean[]): Record<string, unknown> {
  return {
    toolResponse: {
      functionResponses: calls.map((call, index) => ({
        id: call.id,
        name: call.name,
        response: {
          result: applied[index] ? 'ok' : 'ignored',
          scheduling: 'SILENT',
        },
      })),
    },
  };
}

export function commandEnvelope(command: ActiveExpression, now: number): number {
  const t = now - command.startedAt;
  if (t < 0) return 0;
  const duration = Math.max(120, command.durationMs);
  const attack = Math.min(70, duration * 0.18);
  const release = Math.min(280, duration * 0.28);
  const holdEnd = Math.max(attack, duration - release);
  let weight = 0;
  if (t < attack) weight = t / Math.max(1, attack);
  else if (t < holdEnd) weight = 1;
  else if (t < duration) weight = 1 - (t - holdEnd) / Math.max(1, duration - holdEnd);
  if (command.supersededAt && now >= command.supersededAt) {
    const fade = Math.max(80, command.crossfadeMs ?? 180);
    weight *= 1 - Math.min(1, (now - command.supersededAt) / fade);
  }
  return clamp01(weight * command.intensity);
}

export function isCommandActive(command: ActiveExpression | null, now: number): command is ActiveExpression {
  if (!command) return false;
  if (now < command.startedAt) return false;
  const fade = command.supersededAt ? Math.max(80, command.crossfadeMs ?? 180) : 0;
  const naturalEnd = command.startedAt + Math.max(120, command.durationMs);
  const end = command.supersededAt ? Math.min(naturalEnd, command.supersededAt + fade) : naturalEnd;
  return now < end;
}

/** Under a held distress signal only the allowlisted looks may render, whatever asked for them. */
export function allowExpressionUnderDistress(expression: FaceExpression, distress: boolean): boolean {
  if (!distress) return true;
  return DISTRESS_SAFE_EXPRESSIONS.has(expression);
}

export function moodFromToolArgs(args: Record<string, unknown>): MoodCommand | null {
  const raw = typeof args.state === 'string' ? args.state.trim().toLowerCase() : typeof args.mood === 'string' ? args.mood.trim().toLowerCase() : '';
  if (!isMoodState(raw)) return null;
  const intensity = clamp01(typeof args.intensity === 'number' ? args.intensity : Number(args.intensity) || 1);
  return { state: raw, intensity, source: 'tool' };
}

export class ExpressionDirector {
  private items: ActiveExpression[] = [];

  push(command: ActiveExpression, now = command.startedAt): ActiveExpression[] {
    for (const current of this.items) {
      if (!isCommandActive(current, now)) continue;
      if (!channelsOverlap(current.expression, command.expression)) continue;
      current.supersededAt = now;
      current.crossfadeMs = 180;
    }
    this.items.push(command);
    this.items = this.items.filter((item) => isCommandActive(item, now) || item === command);
    return this.active(now);
  }

  active(now: number): ActiveExpression[] {
    this.items = this.items.filter((item) => isCommandActive(item, now));
    return [...this.items];
  }

  /** Fade out every active expression from one source, e.g. a state that has ended. */
  release(source: ExpressionSource, now: number, crossfadeMs = 260): ActiveExpression[] {
    for (const item of this.items) {
      if (item.source !== source || !isCommandActive(item, now) || item.supersededAt) continue;
      item.supersededAt = now;
      item.crossfadeMs = crossfadeMs;
    }
    return this.active(now);
  }

  /**
   * Extend active held looks (e.g. hearts, smiles, soften) so they stay visible
   * during speech playback rather than fading prematurely mid-sentence.
   */
  extendDuringPlayback(minEndAt: number): ActiveExpression[] {
    for (const item of this.items) {
      if (item.expression === 'wink' || item.expression === 'blink_slow') continue;
      const currentEnd = item.startedAt + item.durationMs;
      if (minEndAt > currentEnd) {
        item.durationMs = minEndAt - item.startedAt;
      }
    }
    return [...this.items];
  }

  clear(): void {
    this.items = [];
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
