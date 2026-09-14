/**
 * Session store — sensitive auth/session state held in memory only.
 */

import { create } from 'zustand';

interface SessionState {
  userId: string | null;
  idToken: string | null;
  appCheckToken: string | null;
  isAuthenticated: boolean;
  setAuth: (userId: string | null, idToken: string | null, appCheckToken?: string | null) => void;
  clearAuth: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  userId: null,
  idToken: null,
  appCheckToken: null,
  isAuthenticated: false,
  setAuth: (userId, idToken, appCheckToken = null) =>
    set({ userId, idToken, appCheckToken, isAuthenticated: Boolean(idToken) }),
  clearAuth: () =>
    set({ userId: null, idToken: null, appCheckToken: null, isAuthenticated: false }),
}));
