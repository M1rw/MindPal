/**
 * Streak store — consecutive days you sent a message.
 * Guests: this device. Signed-in: /api/user/insights, with a same-day local merge.
 */

import { create } from 'zustand';
import { STORAGE_KEYS } from '../constants/storage.ts';
import { useSessionStore } from './session.ts';
import type { StreakData, StreakSource, UserInsightsResponse } from '../types/index';
import {
  emptyWeek,
  mondayIndex,
  mondayOf,
  utcToday,
  utcYesterday,
  weekDaysFor,
} from '../utils/streak/streak.ts';

const defaultStreak: StreakData = {
  count: 0,
  lastActiveDate: null,
  weeklyDays: emptyWeek(),
};

interface PersistedStreak extends StreakData {
  totalReflections?: number;
}

interface StreakState {
  streak: StreakData;
  totalReflections: number;
  source: StreakSource;
  isOpen: boolean;
  setStreak: (streak: StreakData) => void;
  setIsOpen: (open: boolean) => void;
  recordActivity: () => void;
  refreshFromAccount: () => Promise<void>;
  restoreDeviceStreak: () => void;
}

function persistDevice(streak: StreakData, totalReflections: number) {
  try {
    const payload: PersistedStreak = { ...streak, totalReflections };
    localStorage.setItem(STORAGE_KEYS.STREAK, JSON.stringify(payload));
  } catch {
    // ignore quota / private mode
  }
}

function loadDeviceStreak(): { streak: StreakData; totalReflections: number } {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.STREAK);
    if (!raw) return { streak: defaultStreak, totalReflections: 0 };
    const parsed = JSON.parse(raw) as PersistedStreak;
    const lastActiveDate = typeof parsed.lastActiveDate === 'string' ? parsed.lastActiveDate : null;
    const count = Number.isFinite(parsed.count) ? Math.max(0, Math.floor(parsed.count)) : 0;
    return {
      streak: {
        count,
        lastActiveDate,
        weeklyDays: weekDaysFor(parsed.weeklyDays, lastActiveDate),
      },
      totalReflections: Number.isFinite(parsed.totalReflections)
        ? Math.max(0, Math.floor(parsed.totalReflections as number))
        : 0,
    };
  } catch {
    return { streak: defaultStreak, totalReflections: 0 };
  }
}

function applyActivity(state: Pick<StreakState, 'streak' | 'totalReflections'>): {
  streak: StreakData;
  totalReflections: number;
} {
  const today = utcToday();
  const last = state.streak.lastActiveDate;
  const totalReflections = state.totalReflections + 1;
  const todayIndex = mondayIndex(today);

  if (last === today) {
    const weeklyDays = [...state.streak.weeklyDays];
    weeklyDays[todayIndex] = true;
    return {
      streak: { ...state.streak, weeklyDays },
      totalReflections,
    };
  }

  const sameWeek = last ? mondayOf(last) === mondayOf(today) : false;
  const weeklyDays = sameWeek ? [...state.streak.weeklyDays] : emptyWeek();
  weeklyDays[todayIndex] = true;

  return {
    streak: {
      count: last === utcYesterday(today) ? state.streak.count + 1 : 1,
      lastActiveDate: today,
      weeklyDays,
    },
    totalReflections,
  };
}

function mergeInsights(
  current: Pick<StreakState, 'streak' | 'totalReflections'>,
  data: UserInsightsResponse
): { streak: StreakData; totalReflections: number } {
  const today = utcToday();
  const todayIndex = mondayIndex(today);
  const localToday = current.streak.lastActiveDate === today;
  const week =
    Array.isArray(data.week_active) && data.week_active.length === 7
      ? data.week_active.map(Boolean)
      : emptyWeek();
  if (localToday) week[todayIndex] = true;

  const serverCount = Math.max(0, Math.floor(data.reflection_streak_days || 0));
  const count = localToday ? Math.max(serverCount, current.streak.count, 1) : serverCount;

  return {
    streak: {
      count,
      lastActiveDate: localToday ? today : data.last_active_date || null,
      weeklyDays: week,
    },
    totalReflections: Math.max(
      current.totalReflections,
      Math.max(0, Math.floor(data.total_reflections || 0))
    ),
  };
}

const initial = loadDeviceStreak();

export const useStreakStore = create<StreakState>((set, get) => ({
  streak: initial.streak,
  totalReflections: initial.totalReflections,
  source: 'device',
  isOpen: false,
  setStreak: (streak) => {
    set({ streak });
    if (!useSessionStore.getState().isAuthenticated) {
      persistDevice(streak, get().totalReflections);
    }
  },
  setIsOpen: (isOpen) => {
    set({ isOpen });
    if (isOpen && useSessionStore.getState().isAuthenticated) {
      void get().refreshFromAccount();
    }
  },
  recordActivity: () => {
    set((state) => {
      const next = applyActivity(state);
      if (!useSessionStore.getState().isAuthenticated) {
        persistDevice(next.streak, next.totalReflections);
      }
      return next;
    });
  },
  refreshFromAccount: async () => {
    if (!useSessionStore.getState().isAuthenticated) return;
    try {
      const { ApiClient } = await import('../services/api/index.ts');
      const data = await ApiClient.getUserInsights();
      set((state) => ({
        ...mergeInsights(state, data),
        source: 'account',
      }));
    } catch {
      // Keep the last honest snapshot; do not invent a dashboard.
    }
  },
  restoreDeviceStreak: () => {
    const device = loadDeviceStreak();
    set({ ...device, source: 'device' });
  },
}));
