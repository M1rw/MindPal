/**
 * Voice store.
 */

import { create } from 'zustand';

interface VoiceState {
  isActive: boolean;
  isMuted: boolean;
  isCapturing: boolean;
  transcript: string;
  aiTranscript: string;
  setIsActive: (active: boolean) => void;
  setIsMuted: (muted: boolean) => void;
  setIsCapturing: (capturing: boolean) => void;
  setTranscript: (text: string) => void;
  appendAiTranscript: (text: string) => void;
  resetVoice: () => void;
}

export const useVoiceStore = create<VoiceState>((set) => ({
  isActive: false,
  isMuted: false,
  isCapturing: false,
  transcript: '',
  aiTranscript: '',
  setIsActive: (isActive) => set({ isActive }),
  setIsMuted: (isMuted) => set({ isMuted }),
  setIsCapturing: (isCapturing) => set({ isCapturing }),
  setTranscript: (transcript) => set({ transcript }),
  appendAiTranscript: (text) => set((state) => ({ aiTranscript: state.aiTranscript + text })),
  resetVoice: () =>
    set({ isActive: false, isMuted: false, isCapturing: false, transcript: '', aiTranscript: '' }),
}));
