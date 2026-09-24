/**
 * Which actions the search palette shows up front, in the person's order.
 * Kept on this device: it is about this screen and keyboard, not the account.
 */

import { create } from 'zustand';

export const DEFAULT_QUICK_ACTIONS = ['new-chat', 'live-voice', 'memory', 'settings'] as const;
const STORAGE_KEY = 'mindpal_palette_quick_actions_v1';
const MAX_QUICK_ACTIONS = 8;

function load(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) return parsed.slice(0, MAX_QUICK_ACTIONS);
  } catch {
    // fall through to defaults
  }
  return [...DEFAULT_QUICK_ACTIONS];
}

function save(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Storage blocked: the choice lasts for this visit.
  }
}

interface PaletteState {
  quickActions: string[];
  togglePinnedAction: (id: string) => void;
  moveAction: (id: string, direction: -1 | 1) => void;
  resetQuickActions: () => void;
}

export const usePaletteStore = create<PaletteState>((set) => ({
  quickActions: load(),
  togglePinnedAction: (id) =>
    set((state) => {
      const next = state.quickActions.includes(id)
        ? state.quickActions.filter((item) => item !== id)
        : [...state.quickActions, id].slice(0, MAX_QUICK_ACTIONS);
      save(next);
      return { quickActions: next };
    }),
  moveAction: (id, direction) =>
    set((state) => {
      const index = state.quickActions.indexOf(id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= state.quickActions.length) return state;
      const next = [...state.quickActions];
      [next[index], next[target]] = [next[target], next[index]];
      save(next);
      return { quickActions: next };
    }),
  resetQuickActions: () => {
    const next = [...DEFAULT_QUICK_ACTIONS];
    save(next);
    set({ quickActions: next });
  },
}));

export const MAX_PINNED_ACTIONS = MAX_QUICK_ACTIONS;
