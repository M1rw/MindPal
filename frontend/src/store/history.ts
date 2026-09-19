/**
 * Chat history store — persistent session list (localStorage) plus cloud sync hooks.
 */

import { create } from 'zustand';
import { STORAGE_KEYS } from '../constants/storage.ts';
import { useSessionStore } from './session.ts';
import type { ChatSession } from '../types/index';
import { withoutSessionMemoryReceipts } from '../utils/chat/sessionHistory.ts';

const loadSessions = (): ChatSession[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CHAT_SESSIONS);
    if (raw) {
      const parsed = JSON.parse(raw) as ChatSession[];
      const cleaned = parsed.map((session) => withoutSessionMemoryReceipts(session));
      if (JSON.stringify(parsed) !== JSON.stringify(cleaned)) {
        saveSessions(cleaned);
      }
      return cleaned;
    }
  } catch {
    // ignore
  }
  return [];
};

const saveSessions = (sessions: ChatSession[]) => {
  try {
    const trimmed = sessions.slice(0, 100).map((session) => withoutSessionMemoryReceipts(session));
    localStorage.setItem(STORAGE_KEYS.CHAT_SESSIONS, JSON.stringify(trimmed));
  } catch {
    // ignore
  }
};

interface ChatHistoryState {
  sessions: ChatSession[];
  activeSessionId: string | null;
  isLoadingCloud: boolean;
  cloudError: string | null;
  saveSession: (session: ChatSession) => void;
  renameSession: (id: string, title: string) => void;
  deleteSession: (id: string) => void;
  clearHistory: () => void;
  setActiveSessionId: (id: string | null) => void;
  ensureActiveSessionId: () => string;
  loadCloudSessions: () => Promise<void>;
}

export const useChatHistoryStore = create<ChatHistoryState>((set, get) => ({
  sessions: loadSessions(),
  activeSessionId: null,
  isLoadingCloud: false,
  cloudError: null,
  saveSession: (session) => {
    const sanitized = withoutSessionMemoryReceipts(session);
    set((state) => {
      const existing = state.sessions.find((s) => s.id === sanitized.id);
      const titleLocked = Boolean(existing?.titleLocked || sanitized.titleLocked);
      const nextSession = {
        ...sanitized,
        title: titleLocked ? (existing?.title ?? sanitized.title) : sanitized.title,
        titleLocked,
      };
      const filtered = state.sessions.filter((s) => s.id !== sanitized.id);
      const next = [nextSession, ...filtered];
      saveSessions(next);
      return { sessions: next, activeSessionId: sanitized.id };
    });
    if (useSessionStore.getState().isAuthenticated) {
      import('../services/api/index.ts').then(({ ApiClient }) => {
        ApiClient.saveChatSession(sanitized).catch((err) => {
          console.warn('Failed to sync chat session to cloud:', err);
        });
      });
    }
  },
  renameSession: (id, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    set((state) => {
      const target = state.sessions.find((s) => s.id === id);
      if (!target) return state;
      const updated = { ...target, title: trimmed, titleLocked: true, updatedAt: new Date().toISOString() };
      const next = state.sessions.map((s) => (s.id === id ? updated : s));
      saveSessions(next);
      if (useSessionStore.getState().isAuthenticated) {
        import('../services/api/index.ts').then(({ ApiClient }) => {
          ApiClient.saveChatSession(updated).catch((err) => {
            console.warn('Failed to sync renamed session to cloud:', err);
          });
        });
      }
      return { sessions: next };
    });
  },
  deleteSession: (id) => {
    set((state) => {
      const next = state.sessions.filter((s) => s.id !== id);
      saveSessions(next);
      return { sessions: next, activeSessionId: state.activeSessionId === id ? null : state.activeSessionId };
    });
    if (useSessionStore.getState().isAuthenticated) {
      import('../services/api/index.ts').then(({ ApiClient }) => {
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
  ensureActiveSessionId: () => {
    const current = get().activeSessionId;
    if (current) return current;
    const id = `sess_${Date.now()}`;
    set({ activeSessionId: id });
    return id;
  },
  loadCloudSessions: async () => {
    try {
      if (!useSessionStore.getState().isAuthenticated) return;
      set({ isLoadingCloud: true, cloudError: null });
      const { ApiClient } = await import('../services/api/index.ts');
      const res = await ApiClient.listChatSessions();
      if (res?.sessions && Array.isArray(res.sessions)) {
        set((state) => {
          const cloudIds = new Set(res.sessions.map((s) => s.id));
          const localOnly = state.sessions.filter((s) => !cloudIds.has(s.id));
          const merged = [...res.sessions, ...localOnly].map((item) => withoutSessionMemoryReceipts(item));
          if (
            merged.length === state.sessions.length &&
            merged.every(
              (s, i) =>
                s.id === state.sessions[i].id &&
                (s.updatedAt || s.createdAt) === (state.sessions[i].updatedAt || state.sessions[i].createdAt)
            )
          ) {
            return { isLoadingCloud: false };
          }
          saveSessions(merged);
          return { sessions: merged, isLoadingCloud: false };
        });
      } else {
        set({ isLoadingCloud: false, cloudError: 'Cloud history returned an invalid response.' });
      }
    } catch (err) {
      console.warn('Failed to load cloud sessions:', err);
      set({
        isLoadingCloud: false,
        cloudError: 'Could not sync cloud history. Your local conversations are still available.',
      });
    }
  },
}));
