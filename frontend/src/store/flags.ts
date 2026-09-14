/**
 * Feature flag store.
 */

import { create } from 'zustand';
import type { FeatureSnapshot } from '../types/index';

interface FlagsState {
  flags: FeatureSnapshot;
  setFlags: (flags: FeatureSnapshot) => void;
}

export const useFlagsStore = create<FlagsState>((set) => ({
  flags: {
    voice_enabled: false,
    presence_enabled: false,
    pro_model_enabled: true,
    memory_enabled: true,
    changelog_enabled: true,
  },
  setFlags: (flags) => set({ flags }),
}));
