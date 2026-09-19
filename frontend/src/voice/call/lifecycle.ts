/**
 * Time and the page: the clock, named timers, and the browser hooks a call
 * needs to end or recover cleanly. Injected so tests run on a virtual clock.
 */
import type { VoiceLiveGrant } from '../types.ts';

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
};

/** One timer per name; setting a name again replaces it. */
export class NamedTimers {
  private readonly ids = new Map<string, unknown>();
  private readonly clock: Clock;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  set(name: string, ms: number, fn: () => void): void {
    this.clear(name);
    this.ids.set(
      name,
      this.clock.setTimeout(() => {
        this.ids.delete(name);
        fn();
      }, ms),
    );
  }

  clear(name: string): void {
    const id = this.ids.get(name);
    if (id === undefined) return;
    this.clock.clearTimeout(id);
    this.ids.delete(name);
  }

  clearAll(): void {
    for (const name of [...this.ids.keys()]) this.clear(name);
  }
}

/** Fetch the next token this long before the current one expires. */
export const RENEW_LEAD_MS = 45_000;

export function renewDelayMs(expiresAt: string, now: number): number | null {
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return null;
  return Math.max(5_000, at - now - RENEW_LEAD_MS);
}

/** Planned provider-socket rotation. Off unless the server asks for it. */
export function rotateDelayMs(rotateS: number | undefined, startedAt: number, now: number): number | null {
  if (!rotateS || rotateS < 60) return null;
  const wait = rotateS * 1000 - (now - startedAt);
  return wait < 5_000 ? null : wait;
}

/** A prepared successor grant, if it can still be used. */
export function usableSuccessor(next: VoiceLiveGrant | null, now: number): VoiceLiveGrant | null {
  if (!next || !next.token || !next.ws_url) return null;
  const startBy = Date.parse(next.new_session_expires_at || '');
  return Number.isFinite(startBy) && startBy <= now ? null : next;
}

/** Short recap a replacement socket can use. Not the full call. */
export function rollingContinuation(input: string, output: string): string {
  const user = input.replace(/\s+/g, ' ').trim().slice(-800);
  const model = output.replace(/\s+/g, ' ').trim().slice(-800);
  if (!user && !model) return '';
  return [
    'Continuing the same live call after a provider session restart.',
    user ? `Recent user: ${user}` : '',
    model ? `Recent MindPal: ${model}` : '',
    'Stay on this thread. Do not greet as if the call just started.',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface PageHooks {
  /** The tab is being closed or navigated away. Returns an unbind. */
  onHide(fn: () => void): () => void;
  /** The tab became visible again. Returns an unbind. */
  onVisible(fn: () => void): () => void;
}

export const browserPage: PageHooks = {
  onHide(fn) {
    window.addEventListener('pagehide', fn);
    return () => window.removeEventListener('pagehide', fn);
  },
  onVisible(fn) {
    const handler = () => {
      if (document.visibilityState === 'visible') fn();
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  },
};
