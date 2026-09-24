/**
 * Settings store.
 *
 * Everything a person can choose lives here, so one place persists it on the
 * device and services/sync/settingsSync.ts carries it to the account.
 */

import { create } from 'zustand';
import { STORAGE_KEYS } from '../constants/storage.ts';
import type { UserUISettings } from '../types/index';

export const DEFAULT_QUICK_ACTIONS = ['new-chat', 'live-voice', 'memory', 'settings'] as const;
export const MAX_QUICK_ACTIONS = 8;
/** Keys confirmAction() may remember; the sync layer only accepts these. */
export const CONFIRM_KEYS = ['new-chat'] as const;

// Device-only keys from before these choices followed the account.
const LEGACY_QUICK_ACTIONS_KEY = 'mindpal_palette_quick_actions_v1';
const LEGACY_SKIP_PREFIX = 'mindpal_confirm_skip:';

export function defaultSettings(): UserUISettings {
  return {
    theme: 'dark',
    soundEnabled: true,
    voiceModel: 'Sulafat',
    voiceLanguage: 'auto',
    personalization: {
      baseStyle: 'balanced',
      warmth: 'warm',
      useHeadersLists: true,
      emojiSupport: true,
    },
    quickActions: [...DEFAULT_QUICK_ACTIONS],
    skipConfirm: {},
  };
}

export function isQuickActionList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_QUICK_ACTIONS &&
    value.every((id) => typeof id === 'string' && /^[a-z][a-z0-9:-]{0,31}$/.test(id)) &&
    new Set(value).size === value.length
  );
}

function legacyDeviceChoices(): Pick<UserUISettings, 'quickActions' | 'skipConfirm'> | null {
  try {
    const raw = localStorage.getItem(LEGACY_QUICK_ACTIONS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    const skipConfirm: Record<string, boolean> = {};
    for (const key of CONFIRM_KEYS) {
      if (localStorage.getItem(LEGACY_SKIP_PREFIX + key) === '1') skipConfirm[key] = true;
    }
    if (!isQuickActionList(parsed) && !Object.keys(skipConfirm).length) return null;
    return { quickActions: isQuickActionList(parsed) ? parsed : [...DEFAULT_QUICK_ACTIONS], skipConfirm };
  } catch {
    return null;
  }
}

function dropLegacyKeys(): void {
  try {
    localStorage.removeItem(LEGACY_QUICK_ACTIONS_KEY);
    for (const key of CONFIRM_KEYS) localStorage.removeItem(LEGACY_SKIP_PREFIX + key);
  } catch {
    // Storage blocked: nothing to clean up.
  }
}

export function loadPersistedSettings(): UserUISettings {
  const defaults = defaultSettings();
  if (typeof window === 'undefined' && typeof localStorage === 'undefined') return defaults;
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    const parsed = raw ? JSON.parse(raw) : {};
    const legacy = legacyDeviceChoices();
    const merged: UserUISettings = {
      ...defaults,
      ...parsed,
      personalization: { ...defaults.personalization, ...(parsed.personalization || {}) },
      quickActions: isQuickActionList(parsed.quickActions)
        ? parsed.quickActions
        : (legacy?.quickActions ?? defaults.quickActions),
      skipConfirm: { ...(legacy?.skipConfirm ?? {}), ...(parsed.skipConfirm || {}) },
    };
    if (legacy) {
      persistSettings(merged);
      dropLegacyKeys();
    }
    return merged;
  } catch {
    return defaults;
  }
}

function persistSettings(settings: UserUISettings) {
  try {
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
  } catch (err) {
    console.warn('Failed to persist settings:', err);
  }
}

interface SettingsState {
  settings: UserUISettings;
  isOpen: boolean;
  activeTab: string;
  /** Nested objects (personalization, skipConfirm) are merged, not replaced. */
  updateSettings: (partial: Partial<UserUISettings>) => void;
  /** Back to defaults, e.g. when an account signs out of this browser. */
  resetSettings: () => void;
  setIsOpen: (isOpen: boolean) => void;
  setActiveTab: (tab: string) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: loadPersistedSettings(),
  isOpen: false,
  activeTab: 'general',
  updateSettings: (partial) =>
    set((state) => {
      const updated: UserUISettings = {
        ...state.settings,
        ...partial,
        personalization: {
          ...state.settings.personalization,
          ...(partial.personalization || {}),
        },
        skipConfirm: {
          ...state.settings.skipConfirm,
          ...(partial.skipConfirm || {}),
        },
      };
      persistSettings(updated);
      return { settings: updated };
    }),
  resetSettings: () => {
    const next = defaultSettings();
    persistSettings(next);
    set({ settings: next });
  },
  setIsOpen: (isOpen) => set({ isOpen }),
  setActiveTab: (activeTab) => set({ activeTab }),
}));
