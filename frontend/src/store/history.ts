/**
 * Chat history store — persistent session list (localStorage) plus cloud sync hooks.
 *
 * History belongs to whoever is signed in. It used to live under one
 * browser-wide key: after A signed out and B signed in, A's private chats were
 * still listed, and opening or renaming one uploaded it into B's account with
 * B's token (audit MP-02). Now:
 *
 *  - each account has its own local list (`mindpal_chat_sessions:acct:<uid>`),
 *    and a guest keeps the original key, so nothing stored before is lost;
 *  - switching owner swaps the list and clears the open conversation;
 *  - every cloud call is bound to the owner it was scheduled for and dropped
 *    if the owner changed before it ran or before its answer came back;
 *  - guest chats are added to an account only when the person asks
 *    (`importGuestSessions`), never on sign-in;
 *  - after "delete my data", local copies are detached from the cloud so an
 *    old conversation is not re-uploaded by the next edit.
 */

import { create } from 'zustand';
import { STORAGE_KEYS } from '../constants/storage.ts';
import { useChatStore } from './chat.ts';
import { useChatHistoryModalStore } from './modals.ts';
import type { ChatSession } from '../types/index';
import { withoutSessionMemoryReceipts } from '../utils/chat/sessionHistory.ts';
import { claim, isGuestOwner, stillOwns, type OwnerClaim, GUEST_OWNER } from '../services/session/owner.ts';

export function historyKey(owner: string): string {
  return owner === GUEST_OWNER ? STORAGE_KEYS.CHAT_SESSIONS : `${STORAGE_KEYS.CHAT_SESSIONS}:acct:${owner}`;
}

const loadSessions = (owner: string): ChatSession[] => {
  try {
    const raw = localStorage.getItem(historyKey(owner));
    if (raw) {
      const parsed = JSON.parse(raw) as ChatSession[];
      const cleaned = parsed.map((session) => withoutSessionMemoryReceipts(session));
      if (JSON.stringify(parsed) !== JSON.stringify(cleaned)) {
        saveSessions(owner, cleaned);
      }
      return cleaned;
    }
  } catch {
    // ignore
  }
  return [];
};

const saveSessions = (owner: string, sessions: ChatSession[]) => {
  try {
    const trimmed = sessions.slice(0, 100).map((session) => withoutSessionMemoryReceipts(session));
    localStorage.setItem(historyKey(owner), JSON.stringify(trimmed));
  } catch {
    // ignore
  }
};

/** Run a cloud call for the owner that scheduled it, or not at all. */
function syncFor(owner: OwnerClaim, run: (api: typeof import('../services/api/index.ts')['ApiClient']) => Promise<unknown>, label: string): void {
  if (isGuestOwner(owner)) return;
  import('../services/api/index.ts').then(({ ApiClient }) => {
    // The token in the request is whoever is signed in now; only send if that is still the owner.
    if (!stillOwns(owner)) return;
    run(ApiClient).catch((err) => {
      console.warn(label, err);
    });
  });
}

interface ChatHistoryState {
  sessions: ChatSession[];
  /** Whose list `sessions` is. */
  owner: string;
  activeSessionId: string | null;
  isLoadingCloud: boolean;
  cloudError: string | null;
  /** Chats saved on this device while signed out, offered for import. */
  guestSessionCount: number;
  saveSession: (session: ChatSession) => void;
  renameSession: (id: string, title: string) => void;
  togglePinned: (id: string) => void;
  deleteSession: (id: string) => void;
  clearHistory: () => void;
  setActiveSessionId: (id: string | null) => void;
  ensureActiveSessionId: () => string;
  loadCloudSessions: () => Promise<void>;
  /** The browser changed hands: show the new owner's list and nothing else. */
  switchOwner: (owner: string) => void;
  /** Explicitly add this device's guest chats to the signed-in account. */
  importGuestSessions: () => number;
  /** After account data deletion: keep local copies, never sync them again. */
  detachFromCloud: () => void;
}

function guestCount(owner: string): number {
  return owner === GUEST_OWNER ? 0 : loadSessions(GUEST_OWNER).length;
}

export const useChatHistoryStore = create<ChatHistoryState>((set, get) => ({
  sessions: loadSessions(GUEST_OWNER),
  owner: GUEST_OWNER,
  activeSessionId: null,
  isLoadingCloud: false,
  cloudError: null,
  guestSessionCount: 0,
  saveSession: (session) => {
    const sanitized = withoutSessionMemoryReceipts(session);
    const owner = claim();
    let toSync: ChatSession | null = null;
    set((state) => {
      const existing = state.sessions.find((s) => s.id === sanitized.id);
      const titleLocked = Boolean(existing?.titleLocked || sanitized.titleLocked);
      const nextSession: ChatSession = {
        ...sanitized,
        title: titleLocked ? (existing?.title ?? sanitized.title) : sanitized.title,
        titleLocked,
        ...(existing?.cloudDetached ? { cloudDetached: true } : {}),
      };
      const filtered = state.sessions.filter((s) => s.id !== sanitized.id);
      const next = [nextSession, ...filtered];
      saveSessions(state.owner, next);
      if (!nextSession.cloudDetached) toSync = nextSession;
      return { sessions: next, activeSessionId: sanitized.id };
    });
    if (toSync) {
      const payload: ChatSession = toSync;
      syncFor(owner, (api) => api.saveChatSession(payload), 'Failed to sync chat session to cloud:');
    }
  },
  renameSession: (id, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const owner = claim();
    let toSync: ChatSession | null = null;
    set((state) => {
      const target = state.sessions.find((s) => s.id === id);
      if (!target) return state;
      const updated = { ...target, title: trimmed, titleLocked: true, updatedAt: new Date().toISOString() };
      const next = state.sessions.map((s) => (s.id === id ? updated : s));
      saveSessions(state.owner, next);
      if (!updated.cloudDetached) toSync = updated;
      return { sessions: next };
    });
    if (toSync) {
      const payload: ChatSession = toSync;
      syncFor(owner, (api) => api.saveChatSession(payload), 'Failed to sync renamed session to cloud:');
    }
  },
  togglePinned: (id) => {
    const owner = claim();
    let toSync: ChatSession | null = null;
    set((state) => {
      const target = state.sessions.find((s) => s.id === id);
      if (!target) return state;
      // Pinning is not activity: the chat keeps its place in date order.
      const updated = { ...target, pinned: !target.pinned };
      const next = state.sessions.map((s) => (s.id === id ? updated : s));
      saveSessions(state.owner, next);
      if (!updated.cloudDetached) toSync = updated;
      return { sessions: next };
    });
    if (toSync) {
      const payload: ChatSession = toSync;
      syncFor(owner, (api) => api.saveChatSession(payload), 'Failed to sync pinned session to cloud:');
    }
  },
  deleteSession: (id) => {
    const owner = claim();
    set((state) => {
      const next = state.sessions.filter((s) => s.id !== id);
      saveSessions(state.owner, next);

      const deletedActiveSession = state.activeSessionId === id;

      if (deletedActiveSession) {
        useChatStore.getState().clearMessages();
        useChatHistoryModalStore.getState().setIsOpen(false);
      }

      return {
        sessions: next,
        activeSessionId: deletedActiveSession ? null : state.activeSessionId,
      };
    });
    syncFor(owner, (api) => api.deleteChatSession(id), 'Failed to delete cloud chat session:');
  },
  clearHistory: () => {
    saveSessions(get().owner, []);
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
    const owner = claim();
    if (isGuestOwner(owner)) return;
    try {
      set({ isLoadingCloud: true, cloudError: null });
      const { ApiClient } = await import('../services/api/index.ts');
      const res = await ApiClient.listChatSessions();
      // Signed out or switched while the list was loading: it is not ours to show.
      if (!stillOwns(owner)) return;
      if (res?.sessions && Array.isArray(res.sessions)) {
        const cloudIds = new Set(res.sessions.map((s) => s.id));
        // Earlier versions kept every account's chats under the one shared
        // key. Anything of this account's still sitting there leaves the
        // guest list now.
        const guest = loadSessions(GUEST_OWNER);
        const guestRemaining = guest.filter((s) => !cloudIds.has(s.id));
        if (guestRemaining.length !== guest.length) saveSessions(GUEST_OWNER, guestRemaining);
        set((state) => {
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
            return { isLoadingCloud: false, guestSessionCount: guestRemaining.length };
          }
          saveSessions(state.owner, merged);
          return { sessions: merged, isLoadingCloud: false, guestSessionCount: guestRemaining.length };
        });
      } else {
        set({ isLoadingCloud: false, cloudError: 'Cloud history returned an invalid response.' });
      }
    } catch (err) {
      if (!stillOwns(owner)) return;
      console.warn('Failed to load cloud sessions:', err);
      set({
        isLoadingCloud: false,
        cloudError: 'Could not sync cloud history. Your local conversations are still available.',
      });
    }
  },
  switchOwner: (owner) => {
    if (owner === get().owner) return;
    useChatStore.getState().clearMessages();
    useChatHistoryModalStore.getState().setIsOpen(false);
    set({
      owner,
      sessions: loadSessions(owner),
      activeSessionId: null,
      isLoadingCloud: false,
      cloudError: null,
      guestSessionCount: guestCount(owner),
    });
  },
  importGuestSessions: () => {
    const owner = claim();
    if (isGuestOwner(owner) || owner.owner !== get().owner) return 0;
    const guest = loadSessions(GUEST_OWNER);
    if (!guest.length) return 0;
    const existing = new Set(get().sessions.map((s) => s.id));
    const imported = guest.filter((s) => !existing.has(s.id)).map((s) => ({ ...s, cloudDetached: undefined }));
    const next = [...get().sessions, ...imported].sort((a, b) =>
      (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt),
    );
    saveSessions(owner.owner, next);
    saveSessions(GUEST_OWNER, []);
    set({ sessions: next, guestSessionCount: 0 });
    for (const session of imported) {
      syncFor(owner, (api) => api.saveChatSession(session), 'Failed to sync imported session to cloud:');
    }
    return imported.length;
  },
  detachFromCloud: () => {
    set((state) => {
      const next = state.sessions.map((s) => ({ ...s, cloudDetached: true }));
      saveSessions(state.owner, next);
      return { sessions: next };
    });
  },
}));
