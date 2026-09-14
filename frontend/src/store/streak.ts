/**
 * Streak store.
 */

import { create } from 'zustand';
import { STORAGE_KEYS } from '../constants/storage.ts';
import type { StreakData } from '../types/index';

const defaultStreak: StreakData = {
  count: 0,
  lastActiveDate: null,
  weeklyDays: [false, false, false, false, false, false, false],
};

interface StreakState {
  streak: StreakData;
  isOpen: boolean;
  setStreak: (streak: StreakData) => void;
  setIsOpen: (open: boolean) => void;
  recordActivity: () => void;
}

export const useStreakStore = create<StreakState>((set) => ({
  streak: (() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.STREAK);
      if (raw) return JSON.parse(raw) as StreakData;
    } catch {
      // ignore
    }
    return defaultStreak;
  })(),
  isOpen: false,
  setStreak: (streak) => {
    set({ streak });
    try {
      localStorage.setItem(STORAGE_KEYS.STREAK, JSON.stringify(streak));
    } catch {
      // ignore
    }
  },
  setIsOpen: (isOpen) => set({ isOpen }),
  recordActivity: () => {
    set((state) => {
      const today = new Date().toISOString().split('T')[0];
      const last = state.streak.lastActiveDate;
      if (last === today) return state;

      const yesterday = new Date(Date.now() - 86_400_000).toISOString().split('T')[0];
      const newCount = last === yesterday ? state.streak.count + 1 : 1;
      const dayIndex = new Date().getDay();
      const monIndex = (dayIndex + 6) % 7;
      const newWeekly = [...state.streak.weeklyDays] as boolean[];
      if (last && new Date(last).getDay() !== new Date().getDay()) {
        newWeekly[monIndex] = true;
      }

      const newStreak: StreakData = {
        count: newCount,
        lastActiveDate: today,
        weeklyDays: newWeekly,
      };
      try {
        localStorage.setItem(STORAGE_KEYS.STREAK, JSON.stringify(newStreak));
      } catch {
        // ignore
      }
      return { streak: newStreak };
    });
  },
}));
