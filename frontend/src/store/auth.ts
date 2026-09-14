/**
 * Auth store — Firebase user profile state.
 */

import { create } from 'zustand';
import type { AuthUser } from '../types/index';

interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthModalOpen: boolean;
  authModalView: 'choice' | 'email' | 'phone' | 'phone-code';
  setUser: (user: AuthUser | null) => void;
  setIsLoading: (loading: boolean) => void;
  openAuthModal: () => void;
  closeAuthModal: () => void;
  setAuthModalView: (view: AuthState['authModalView']) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,
  isAuthModalOpen: false,
  authModalView: 'choice',
  setUser: (user) => set({ user }),
  setIsLoading: (isLoading) => set({ isLoading }),
  openAuthModal: () => set({ isAuthModalOpen: true, authModalView: 'choice' }),
  closeAuthModal: () => set({ isAuthModalOpen: false }),
  setAuthModalView: (authModalView) => set({ authModalView }),
}));
