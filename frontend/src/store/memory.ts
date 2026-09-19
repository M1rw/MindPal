/**
 * Memory store.
 */

import { create } from 'zustand';
import type { MemorySummaryResponse } from '../types/index';

export type MemoryInspectTab = 'summary' | 'atoms';

interface MemoryOpenOptions {
  returnToSettings?: boolean;
}

interface MemoryState {
  summary: MemorySummaryResponse | null;
  isOpen: boolean;
  inspectTab: MemoryInspectTab;
  highlightAtomIds: string[];
  returnToSettings: boolean;
  isLoading: boolean;
  error: string | null;
  setSummary: (summary: MemorySummaryResponse) => void;
  setIsOpen: (
    open: boolean,
    tab?: MemoryInspectTab,
    highlightAtomIds?: string[],
    options?: MemoryOpenOptions
  ) => void;
  setIsLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;
}

function uniqueIds(ids: string[] | undefined): string[] {
  if (!ids?.length) return [];
  const seen = new Set<string>();
  const next: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  return next;
}

export const useMemoryStore = create<MemoryState>((set) => ({
  summary: null,
  isOpen: false,
  inspectTab: 'summary',
  highlightAtomIds: [],
  returnToSettings: false,
  isLoading: false,
  error: null,
  setSummary: (summary) => set({ summary, error: null }),
  setIsOpen: (isOpen, tab, highlightAtomIds, options) =>
    set({
      isOpen,
      inspectTab: isOpen ? (tab ?? 'summary') : 'summary',
      highlightAtomIds: isOpen ? uniqueIds(highlightAtomIds) : [],
      returnToSettings: isOpen ? Boolean(options?.returnToSettings) : false,
    }),
  setIsLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
}));
