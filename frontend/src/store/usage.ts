/**
 * Usage store.
 */

import { create } from 'zustand';
import type { UsageQuota } from '../types/index';

interface UsageState {
  quota: UsageQuota | null;
  setQuota: (quota: UsageQuota) => void;
}

export const useUsageStore = create<UsageState>((set) => ({
  quota: null,
  setQuota: (quota) => set({ quota }),
}));
