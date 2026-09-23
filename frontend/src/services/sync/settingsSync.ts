/**
 * Settings follow the account.
 *
 * Settings used to live only in localStorage, and PATCH /api/user/profile was
 * never called, so a signed-in person's reply style, warmth and voice choice
 * reset on every new device. Now:
 *
 *  - on sign-in, the account's saved settings are pulled and win over the
 *    device copy (the account is the source of truth once there is one);
 *  - any later change is pushed, debounced, as a flat scalar map, because the
 *    profile endpoint only accepts scalars;
 *  - guests keep the device-only behaviour.
 *
 * Only known keys with allowed values are ever applied from the server, so a
 * stale or hand-edited profile cannot put the UI into an invalid state.
 */

import { useSessionStore, useSettingsStore } from '../../store/index.ts';
import { usersApi } from '../api/users.ts';
import type { UserUISettings } from '../../types/index.ts';

type Flat = Record<string, string | number | boolean | null>;

const ONE_OF = (...values: string[]) => (v: unknown) => typeof v === 'string' && values.includes(v);
const IS_BOOL = (v: unknown) => typeof v === 'boolean';
const SHORT_TEXT = (max: number) => (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= max;

const FIELDS: Record<string, (v: unknown) => boolean> = {
  theme: ONE_OF('light', 'dark', 'system'),
  soundEnabled: IS_BOOL,
  voiceModel: SHORT_TEXT(64),
  voiceLanguage: SHORT_TEXT(16),
  'personalization.baseStyle': ONE_OF('concise', 'detailed', 'balanced'),
  'personalization.warmth': ONE_OF('warm', 'neutral', 'direct'),
  'personalization.useHeadersLists': IS_BOOL,
  'personalization.emojiSupport': IS_BOOL,
};

const PUSH_DELAY_MS = 800;

export function toProfileSettings(settings: UserUISettings): Flat {
  return {
    theme: settings.theme,
    soundEnabled: settings.soundEnabled,
    voiceModel: settings.voiceModel,
    voiceLanguage: settings.voiceLanguage,
    'personalization.baseStyle': settings.personalization.baseStyle,
    'personalization.warmth': settings.personalization.warmth,
    'personalization.useHeadersLists': settings.personalization.useHeadersLists,
    'personalization.emojiSupport': settings.personalization.emojiSupport,
  };
}

/** The valid subset of a stored profile map, shaped as a settings update. */
export function fromProfileSettings(flat: unknown): Partial<UserUISettings> | null {
  if (!flat || typeof flat !== 'object') return null;
  const source = flat as Record<string, unknown>;
  const top: Record<string, unknown> = {};
  const personalization: Record<string, unknown> = {};
  for (const [key, valid] of Object.entries(FIELDS)) {
    if (!(key in source) || !valid(source[key])) continue;
    if (key.startsWith('personalization.')) personalization[key.slice('personalization.'.length)] = source[key];
    else top[key] = source[key];
  }
  if (!Object.keys(top).length && !Object.keys(personalization).length) return null;
  const partial = top as Partial<UserUISettings>;
  if (Object.keys(personalization).length) {
    partial.personalization = personalization as unknown as UserUISettings['personalization'];
  }
  return partial;
}

function changedKeys(before: Flat, after: Flat): Flat {
  const diff: Flat = {};
  for (const key of Object.keys(after)) {
    if (before[key] !== after[key]) diff[key] = after[key];
  }
  return diff;
}

let applyingRemote = false;
let lastSynced: Flat = {};

/** Pull the account's settings into the store; push any the account lacks. */
export async function pullAccountSettings(): Promise<void> {
  const profile = await usersApi.getUserProfile();
  const remote = fromProfileSettings(profile?.settings);
  if (remote) {
    applyingRemote = true;
    try {
      useSettingsStore.getState().updateSettings(remote);
    } finally {
      applyingRemote = false;
    }
  }
  const local = toProfileSettings(useSettingsStore.getState().settings);
  const stored = (profile?.settings ?? {}) as Flat;
  const missing = changedKeys(stored, local);
  lastSynced = { ...local };
  if (Object.keys(missing).length) {
    await usersApi.patchUserProfile({ settings: missing });
  }
}

/** Push changes while signed in. Returns an unsubscribe function. */
export function subscribeSettingsSync(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = useSettingsStore.subscribe((state, previous) => {
    if (applyingRemote || state.settings === previous.settings) return;
    if (!useSessionStore.getState().isAuthenticated) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const next = toProfileSettings(useSettingsStore.getState().settings);
      const diff = changedKeys(lastSynced, next);
      if (!Object.keys(diff).length) return;
      usersApi
        .patchUserProfile({ settings: diff })
        .then(() => {
          lastSynced = { ...lastSynced, ...diff };
        })
        .catch(() => {
          // Kept on the device; the next change or sign-in retries the diff.
        });
    }, PUSH_DELAY_MS);
  });
  return () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}

/** Forget what was synced, so the next account starts from its own profile. */
export function resetSettingsSync(): void {
  lastSynced = {};
}
