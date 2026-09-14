/**
 * MindPal Zustand Stores
 * Unidirectional reactive state — views emit actions, store mutates, views re-render.
 * Security: sensitive tokens are held only in memory (never localStorage/sessionStorage).
 */

import { create } from 'zustand';
import type {
  ChatMessage,
  ChatSession,
  UserUISettings,
  MemorySummaryResponse,
  AuthUser,
  ToastItem,
  ToastKind,
  StreakData,
  FeatureSnapshot,
  UsageQuota,
  ChangelogResponse,
} from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Session Store — Auth tokens (in-memory only, cleared on logout/tab close)
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Auth Store — Firebase user profile state
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Chat Store — Messages, generation state, model/mode selection
// ─────────────────────────────────────────────────────────────────────────────

interface ChatState {
  messages: ChatMessage[];
  isGenerating: boolean;
  activeModel: string;
  activeMode: string;
  strategyUsed: string | null;
  addMessage: (msg: ChatMessage) => void;
  setMessages: (messages: ChatMessage[]) => void;
  updateMessage: (id: string, content: string, strategy?: string) => void;
  removeMessage: (id: string) => void;
  updateLastMessage: (content: string, strategy?: string) => void;
  setIsGenerating: (generating: boolean) => void;
  setActiveModel: (model: string) => void;
  setActiveMode: (mode: string) => void;
  clearMessages: () => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  isGenerating: false,
  activeModel: 'standard',
  activeMode: 'Active Listen',
  strategyUsed: null,
  addMessage: (msg) => set((state) => ({ messages: [...state.messages, msg] })),
  setMessages: (messages) => set({ messages, strategyUsed: null }),
  updateMessage: (id, content, strategy) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === id
          ? { ...m, content, ...(strategy ? { strategy_used: strategy } : {}) }
          : m
      ),
      strategyUsed: strategy ?? state.strategyUsed,
    })),
  removeMessage: (id) =>
    set((state) => ({
      messages: state.messages.filter((m) => m.id !== id),
    })),
  updateLastMessage: (content, strategy) =>
    set((state) => {
      if (state.messages.length === 0) return state;
      const last = { ...state.messages[state.messages.length - 1] };
      last.content = content;
      if (strategy) last.strategy_used = strategy;
      return {
        messages: [...state.messages.slice(0, -1), last],
        strategyUsed: strategy ?? state.strategyUsed,
      };
    }),
  setIsGenerating: (isGenerating) => set({ isGenerating }),
  setActiveModel: (activeModel) => set({ activeModel }),
  setActiveMode: (activeMode) => set({ activeMode }),
  clearMessages: () => set({ messages: [], strategyUsed: null }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Voice Store
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Memory Store
// ─────────────────────────────────────────────────────────────────────────────

interface MemoryState {
  summary: MemorySummaryResponse | null;
  isOpen: boolean;
  isLoading: boolean;
  error: string | null;
  setSummary: (summary: MemorySummaryResponse) => void;
  setIsOpen: (open: boolean) => void;
  setIsLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useMemoryStore = create<MemoryState>((set) => ({
  summary: null,
  isOpen: false,
  isLoading: false,
  error: null,
  setSummary: (summary) => set({ summary, error: null }),
  setIsOpen: (isOpen) => set({ isOpen }),
  setIsLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Settings Store
// ─────────────────────────────────────────────────────────────────────────────

const defaultSettings: UserUISettings = {
  theme: 'dark',
  soundEnabled: true,
  voiceModel: 'advanced',
  voiceLanguage: 'auto',
  personalization: {
    baseStyle: 'balanced',
    warmth: 'warm',
    useHeadersLists: true,
    emojiSupport: true,
  },
};

interface SettingsState {
  settings: UserUISettings;
  isOpen: boolean;
  activeTab: string;
  updateSettings: (partial: Partial<UserUISettings>) => void;
  setIsOpen: (isOpen: boolean) => void;
  setActiveTab: (tab: string) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: defaultSettings,
  isOpen: false,
  activeTab: 'general',
  updateSettings: (partial) =>
    set((state) => ({ settings: { ...state.settings, ...partial } })),
  setIsOpen: (isOpen) => set({ isOpen }),
  setActiveTab: (activeTab) => set({ activeTab }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Toast Store
// ─────────────────────────────────────────────────────────────────────────────

interface ToastState {
  toasts: ToastItem[];
  push: (message: string, kind?: ToastKind) => void;
  dismiss: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (message, kind = 'info') => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    set((state) => ({ toasts: [...state.toasts, { id, message, kind }] }));
    // Auto-dismiss after 4 seconds
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
    }, 4000);
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Streak Store
// ─────────────────────────────────────────────────────────────────────────────

const defaultStreak: StreakData = {
  count: 0,
  lastActiveDate: null,
  weeklyDays: [false, false, false, false, false, false, false],
};

interface StreakState {
  streak: StreakData;
  isOpen: boolean;
  setStreak: (streak: StreakData) => void;
  setIsOpen: (open: boolean) => void;
  recordActivity: () => void;
}

export const useStreakStore = create<StreakState>((set) => ({
  streak: (() => {
    // Restore streak from localStorage (non-sensitive; just streak metadata)
    try {
      const raw = localStorage.getItem('mindpal_streak');
      if (raw) return JSON.parse(raw) as StreakData;
    } catch { /* ignore */ }
    return defaultStreak;
  })(),
  isOpen: false,
  setStreak: (streak) => {
    set({ streak });
    try { localStorage.setItem('mindpal_streak', JSON.stringify(streak)); } catch { /* ignore */ }
  },
  setIsOpen: (isOpen) => set({ isOpen }),
  recordActivity: () => {
    set((state) => {
      const today = new Date().toISOString().split('T')[0];
      const last = state.streak.lastActiveDate;
      if (last === today) return state; // Already recorded today

      const yesterday = new Date(Date.now() - 86_400_000).toISOString().split('T')[0];
      const newCount = last === yesterday ? state.streak.count + 1 : 1;
      const dayIndex = new Date().getDay(); // 0=Sun...6=Sat → remap to Mon=0
      const monIndex = (dayIndex + 6) % 7;
      const newWeekly = [...state.streak.weeklyDays] as boolean[];
      // Reset weekly if new week
      if (last && new Date(last).getDay() !== new Date().getDay()) {
        newWeekly[monIndex] = true;
      }

      const newStreak: StreakData = {
        count: newCount,
        lastActiveDate: today,
        weeklyDays: newWeekly,
      };
      try { localStorage.setItem('mindpal_streak', JSON.stringify(newStreak)); } catch { /* ignore */ }
      return { streak: newStreak };
    });
  },
}));

// ─────────────────────────────────────────────────────────────────────────────
// Feature Flags Store
// ─────────────────────────────────────────────────────────────────────────────

interface FlagsState {
  flags: FeatureSnapshot;
  setFlags: (flags: FeatureSnapshot) => void;
}

export const useFlagsStore = create<FlagsState>((set) => ({
  flags: {
    voice_enabled: true,
    pro_model_enabled: true,
    memory_enabled: true,
    changelog_enabled: true,
  },
  setFlags: (flags) => set({ flags }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Usage Store
// ─────────────────────────────────────────────────────────────────────────────

interface UsageState {
  quota: UsageQuota | null;
  setQuota: (quota: UsageQuota) => void;
}

export const useUsageStore = create<UsageState>((set) => ({
  quota: null,
  setQuota: (quota) => set({ quota }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Changelog Store
// ─────────────────────────────────────────────────────────────────────────────

interface ChangelogState {
  isOpen: boolean;
  changelog: ChangelogResponse | null;
  setIsOpen: (isOpen: boolean) => void;
  setChangelog: (changelog: ChangelogResponse | null) => void;
}

export const useChangelogStore = create<ChangelogState>((set) => ({
  isOpen: false,
  changelog: null,
  setIsOpen: (isOpen) => set({ isOpen }),
  setChangelog: (changelog) => set({ changelog }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Chat History Store — Persistent session list (localStorage)
// ─────────────────────────────────────────────────────────────────────────────

const HISTORY_KEY = 'mindpal_chat_sessions';

const loadSessions = (): ChatSession[] => {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw) return JSON.parse(raw) as ChatSession[];
  } catch { /* ignore */ }
  return [];
};

const saveSessions = (sessions: ChatSession[]) => {
  try {
    // Keep last 100 sessions
    const trimmed = sessions.slice(0, 100);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
  } catch { /* ignore */ }
};

interface ChatHistoryState {
  sessions: ChatSession[];
  activeSessionId: string | null;
  isLoadingCloud: boolean;
  saveSession: (session: ChatSession) => void;
  deleteSession: (id: string) => void;
  clearHistory: () => void;
  setActiveSessionId: (id: string | null) => void;
  loadCloudSessions: () => Promise<void>;
}

export const useChatHistoryStore = create<ChatHistoryState>((set) => ({
  sessions: loadSessions(),
  activeSessionId: null,
  isLoadingCloud: false,
  saveSession: (session) => {
    set((state) => {
      const filtered = state.sessions.filter((s) => s.id !== session.id);
      const next = [session, ...filtered];
      saveSessions(next);
      return { sessions: next, activeSessionId: session.id };
    });
    if (useSessionStore.getState().isAuthenticated) {
      import('../services/api').then(({ ApiClient }) => {
        ApiClient.saveChatSession(session).catch((err) => {
          console.warn('Failed to sync chat session to cloud:', err);
        });
      });
    }
  },
  deleteSession: (id) => {
    set((state) => {
      const next = state.sessions.filter((s) => s.id !== id);
      saveSessions(next);
      return { sessions: next, activeSessionId: state.activeSessionId === id ? null : state.activeSessionId };
    });
    if (useSessionStore.getState().isAuthenticated) {
      import('../services/api').then(({ ApiClient }) => {
        ApiClient.deleteChatSession(id).catch((err) => {
          console.warn('Failed to delete cloud chat session:', err);
        });
      });
    }
  },
  clearHistory: () => {
    saveSessions([]);
    set({ sessions: [], activeSessionId: null });
  },
  setActiveSessionId: (id) => set({ activeSessionId: id }),
  loadCloudSessions: async () => {
    try {
      if (!useSessionStore.getState().isAuthenticated) return;
      set({ isLoadingCloud: true });
      const { ApiClient } = await import('../services/api');
      const res = await ApiClient.listChatSessions();
      if (res?.sessions && Array.isArray(res.sessions)) {
        set((state) => {
          const cloudIds = new Set(res.sessions.map((s) => s.id));
          const localOnly = state.sessions.filter((s) => !cloudIds.has(s.id));
          const merged = [...res.sessions, ...localOnly];
          saveSessions(merged);
          return { sessions: merged, isLoadingCloud: false };
        });
      } else {
        set({ isLoadingCloud: false });
      }
    } catch (err) {
      console.warn('Failed to load cloud sessions:', err);
      set({ isLoadingCloud: false });
    }
  },
}));

// ─────────────────────────────────────────────────────────────────────────────
// Chat History Modal Store
// ─────────────────────────────────────────────────────────────────────────────

interface ChatHistoryModalState {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}

export const useChatHistoryModalStore = create<ChatHistoryModalState>((set) => ({
  isOpen: false,
  setIsOpen: (isOpen) => set({ isOpen }),
}));
