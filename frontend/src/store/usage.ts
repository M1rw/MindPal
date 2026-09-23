/**
 * Usage store: the latest chat credit snapshot from the server.
 *
 * Written by the chat stream after each turn and by GET /api/usage when the
 * Usage screen opens or the account changes. Cleared on sign-in and sign-out,
 * because a guest's per-network window is not the account's.
 */

import { create } from 'zustand';
import type { UsageQuota } from '../types/index';

interface UsageState {
  quota: UsageQuota | null;
  setQuota: (quota: UsageQuota) => void;
  clearQuota: () => void;
}

export const useUsageStore = create<UsageState>((set) => ({
  quota: null,
  setQuota: (quota) => set({ quota }),
  clearQuota: () => set({ quota: null }),
}));
