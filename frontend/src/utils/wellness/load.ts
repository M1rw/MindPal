/**
 * Decide how Settings Mental health / Analytics should load.
 * Guests and 401s use this-device reflection. Real 5xx stays an error.
 */

import type { ChatMessage, ChatSession, MemoryAtom, WellnessTimeline } from '../../types/index.ts';
import { emptyWellnessTimeline, reflectWellnessFromDevice } from './reflect.ts';

export type WellnessLoadResult = {
  data: WellnessTimeline | null;
  error: string | null;
  signedIn: boolean;
};

export function isWellnessAuthMiss(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { status?: unknown; code?: unknown };
  return record.status === 401 || record.code === 'unauthenticated';
}

export function localDeviceWellness(input: {
  atoms?: MemoryAtom[];
  sessions?: ChatSession[];
  extraMessages?: ChatMessage[];
}): WellnessTimeline {
  try {
    return reflectWellnessFromDevice({
      atoms: input.atoms ?? [],
      sessions: input.sessions ?? [],
      extraMessages: input.extraMessages,
    });
  } catch {
    return emptyWellnessTimeline();
  }
}

export async function loadWellnessTimeline(options: {
  signedIn: boolean;
  fetchAccount: () => Promise<WellnessTimeline>;
  local: () => WellnessTimeline;
}): Promise<WellnessLoadResult> {
  if (!options.signedIn) {
    return { data: options.local(), error: null, signedIn: false };
  }

  try {
    const payload = await options.fetchAccount();
    return { data: payload, error: null, signedIn: true };
  } catch (err: unknown) {
    if (isWellnessAuthMiss(err)) {
      return { data: options.local(), error: null, signedIn: false };
    }
    const message =
      err instanceof Error && err.message ? err.message : 'Unable to load this reflection right now.';
    return { data: null, error: message, signedIn: true };
  }
}
