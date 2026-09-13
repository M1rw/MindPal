import { create } from 'zustand';
import { ChatMessage, UserUISettings, MemorySummaryResponse } from '../types';

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
  clearAuth: () => set({ userId: null, idToken: null, appCheckToken: null, isAuthenticated: false }),
}));

interface ChatState {
  messages: ChatMessage[];
  isGenerating: boolean;
  activeModel: string;
  strategyUsed: string | null;
  addMessage: (msg: ChatMessage) => void;
  updateLastMessage: (content: string, strategy?: string) => void;
  setIsGenerating: (generating: boolean) => void;
  setActiveModel: (model: string) => void;
  clearMessages: () => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  isGenerating: false,
  activeModel: 'pro',
  strategyUsed: null,
  addMessage: (msg) => set((state) => ({ messages: [...state.messages, msg] })),
  updateLastMessage: (content, strategy) =>
    set((state) => {
      if (state.messages.length === 0) return state;
      const last = { ...state.messages[state.messages.length - 1] };
      last.content = content;
      if (strategy) last.strategy_used = strategy;
      return {
        messages: [...state.messages.slice(0, -1), last],
        strategyUsed: strategy || state.strategyUsed,
      };
    }),
  setIsGenerating: (isGenerating) => set({ isGenerating }),
  setActiveModel: (activeModel) => set({ activeModel }),
  clearMessages: () => set({ messages: [], strategyUsed: null }),
}));

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
  resetVoice: () => set({ isActive: false, isMuted: false, isCapturing: false, transcript: '', aiTranscript: '' }),
}));

interface MemoryState {
  summary: MemorySummaryResponse | null;
  isLoading: boolean;
  error: string | null;
  setSummary: (summary: MemorySummaryResponse) => void;
  setIsLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useMemoryStore = create<MemoryState>((set) => ({
  summary: null,
  isLoading: false,
  error: null,
  setSummary: (summary) => set({ summary, error: null }),
  setIsLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
}));

interface SettingsState {
  settings: UserUISettings;
  isOpen: boolean;
  activeTab: string;
  updateSettings: (partial: Partial<UserUISettings>) => void;
  setIsOpen: (isOpen: boolean) => void;
  setActiveTab: (tab: string) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: {
    theme: 'dark',
    soundEnabled: true,
    personalization: {
      baseStyle: 'balanced',
      warmth: 'warm',
      useHeadersLists: true,
      emojiSupport: true,
    },
  },
  isOpen: false,
  activeTab: 'general',
  updateSettings: (partial) =>
    set((state) => ({ settings: { ...state.settings, ...partial } })),
  setIsOpen: (isOpen) => set({ isOpen }),
  setActiveTab: (activeTab) => set({ activeTab }),
}));
