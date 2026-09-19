/**
 * Toast store.
 */

import { create } from 'zustand';
import type { ToastItem, ToastKind } from '../types/index';

const TOAST_HOLD_MS = 4000;
const TOAST_EXIT_MS = 280;

interface ToastState {
  toasts: ToastItem[];
  push: (message: string, kind?: ToastKind) => void;
  dismiss: (id: string) => void;
}

export const useToastStore = create<ToastState>((set, get) => {
  const beginExit = (id: string) => {
    const current = get().toasts.find((toast) => toast.id === id);
    if (!current || current.leaving) return;
    set((state) => ({
      toasts: state.toasts.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)),
    }));
    window.setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
    }, TOAST_EXIT_MS);
  };

  return {
    toasts: [],
    push: (message, kind = 'info') => {
      const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      set((state) => ({ toasts: [...state.toasts, { id, message, kind }] }));
      window.setTimeout(() => beginExit(id), TOAST_HOLD_MS);
    },
    dismiss: beginExit,
  };
});
