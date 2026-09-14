/**
 * Settings store.
 */

import { create } from 'zustand';
import { STORAGE_KEYS } from '../constants/storage.ts';
import type { UserUISettings } from '../types/index';

const defaultSettings: UserUISettings = {
  theme: 'dark',
  soundEnabled: true,
  voiceModel: 'advanced',
  voiceLanguage: 'auto',
  personalization: {
    baseStyle: 'balanced',
    warmth: 'warm',
    useHeadersLists: true,
    emojiSupport: true,
  },
};

function loadPersistedSettings(): UserUISettings {
  if (typeof window === 'undefined') return defaultSettings;
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    if (!raw) return defaultSettings;
    const parsed = JSON.parse(raw);
    return {
      ...defaultSettings,
      ...parsed,
      personalization: {
        ...defaultSettings.personalization,
        ...(parsed.personalization || {}),
      },
    };
  } catch {
    return defaultSettings;
  }
}

function persistSettings(settings: UserUISettings) {
  if (typeof window === 'undefined') return;
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
  updateSettings: (partial: Partial<UserUISettings>) => void;
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
      };
      persistSettings(updated);
      return { settings: updated };
    }),
  setIsOpen: (isOpen) => set({ isOpen }),
  setActiveTab: (activeTab) => set({ activeTab }),
}));
