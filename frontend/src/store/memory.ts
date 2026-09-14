/**
 * Memory store.
 */

import { create } from 'zustand';
import type { MemorySummaryResponse } from '../types/index';

interface MemoryState {
  summary: MemorySummaryResponse | null;
  isOpen: boolean;
  isLoading: boolean;
  error: string | null;
  setSummary: (summary: MemorySummaryResponse) => void;
  setIsOpen: (open: boolean) => void;
  setIsLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useMemoryStore = create<MemoryState>((set) => ({
  summary: null,
  isOpen: false,
  isLoading: false,
  error: null,
  setSummary: (summary) => set({ summary, error: null }),
  setIsOpen: (isOpen) => set({ isOpen }),
  setIsLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
}));
