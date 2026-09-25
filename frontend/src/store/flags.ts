/**
 * Feature flag store.
 */

import { create } from 'zustand';
import type { FeatureSnapshot } from '../types/index';

interface FlagsState {
  flags: FeatureSnapshot;
  setFlags: (flags: FeatureSnapshot) => void;
}

export const DEFAULT_FLAGS: FeatureSnapshot = {
  voice_enabled: true,
  presence_enabled: false,
  pro_model_enabled: true,
  memory_enabled: true,
  files_enabled: true,
  changelog_enabled: true,
};

export const useFlagsStore = create<FlagsState>((set) => ({
  flags: { ...DEFAULT_FLAGS },
  setFlags: (flags) => set({ flags }),
}));
