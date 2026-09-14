/**
 * Changelog store.
 */

import { create } from 'zustand';
import type { ChangelogResponse } from '../types/index';

interface ChangelogState {
  isOpen: boolean;
  changelog: ChangelogResponse | null;
  setIsOpen: (isOpen: boolean) => void;
  setChangelog: (changelog: ChangelogResponse | null) => void;
}

export const useChangelogStore = create<ChangelogState>((set) => ({
  isOpen: false,
  changelog: null,
  setIsOpen: (isOpen) => set({ isOpen }),
  setChangelog: (changelog) => set({ changelog }),
}));
