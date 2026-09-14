/**
 * Modal state stores.
 */

import { create } from 'zustand';

interface ChatHistoryModalState {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}

export const useChatHistoryModalStore = create<ChatHistoryModalState>((set) => ({
  isOpen: false,
  setIsOpen: (isOpen) => set({ isOpen }),
}));
