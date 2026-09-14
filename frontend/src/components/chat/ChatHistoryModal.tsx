import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Search, X, Trash2, MessageSquare, Clock, Check } from 'lucide-react';
import { useChatHistoryStore, useChatHistoryModalStore, useChatStore } from '../../store';
import type { ChatSession } from '../../types';

// ─── Time helpers ─────────────────────────────────────────────────────────────

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 2) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffWeeks < 5) return `${diffWeeks} wk ago`;
  if (diffMonths < 12) return `${diffMonths} mo ago`;
  return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function groupSessions(sessions: ChatSession[]): { label: string; items: ChatSession[] }[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86_400_000;
  const weekAgo = today - 7 * 86_400_000;
  const monthAgo = today - 30 * 86_400_000;

  const groups: Record<string, ChatSession[]> = {
    Today: [],
    Yesterday: [],
    'This week': [],
    'This month': [],
    Older: [],
  };

  for (const s of sessions) {
    const t = new Date(s.updatedAt || s.createdAt).getTime();
    if (t >= today) groups['Today'].push(s);
    else if (t >= yesterday) groups['Yesterday'].push(s);
    else if (t >= weekAgo) groups['This week'].push(s);
    else if (t >= monthAgo) groups['This month'].push(s);
    else groups['Older'].push(s);
  }

  return Object.entries(groups)
    .filter(([, items]) => items.length > 0)
    .map(([label, items]) => ({ label, items }));
}

// ─── Component ────────────────────────────────────────────────────────────────

export const ChatHistoryModal: React.FC = () => {
  const { isOpen, setIsOpen } = useChatHistoryModalStore();
  const { sessions, activeSessionId, deleteSession, setActiveSessionId } = useChatHistoryStore();
  const { setMessages } = useChatStore();

  const [query, setQuery] = useState('');
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setMounted(true);
      useChatHistoryStore.getState().loadCloudSessions();
      // Fast single tick transition without nested RAF stutter
      const raf = requestAnimationFrame(() => setVisible(true));
      const focusTimer = setTimeout(() => searchRef.current?.focus(), 60);
      return () => {
        cancelAnimationFrame(raf);
        clearTimeout(focusTimer);
      };
    } else {
      setVisible(false);
      const timer = setTimeout(() => {
        setMounted(false);
        setQuery('');
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    if (isOpen) window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, setIsOpen]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === backdropRef.current) setIsOpen(false);
    },
    [setIsOpen]
  );

  const handleLoadSession = useCallback(
    (session: ChatSession) => {
      // Single atomic store update — avoids N re-renders
      setMessages(session.messages);
      setActiveSessionId(session.id);
      setIsOpen(false);
    },
    [setMessages, setActiveSessionId, setIsOpen]
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      deleteSession(id);
    },
    [deleteSession]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.messages.some((m) => m.content.toLowerCase().includes(q))
    );
  }, [sessions, query]);

  const groups = useMemo(() => groupSessions(filtered), [filtered]);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && filtered.length > 0) {
      handleLoadSession(filtered[0]);
    }
  };

  if (!mounted) return null;

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className={`fixed inset-0 z-[200] flex items-start justify-center pt-[72px] px-4 bg-black/40 backdrop-blur-sm transition-opacity duration-200 ease-out ${
        visible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
      }`}
      role="dialog"
      aria-modal="true"
      aria-label="Chat history"
    >
      <div
        className={`w-full max-w-lg bg-white dark:bg-[#1c1c1e] rounded-2xl shadow-2xl overflow-hidden border border-black/[0.08] dark:border-white/[0.08] transform transition-all duration-200 ease-out ${
          visible ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 -translate-y-2 scale-[0.98]'
        }`}
        style={{ maxHeight: 'calc(100dvh - 100px)' }}
      >
        {/* Search Bar */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-black/[0.06] dark:border-white/[0.06]">
          <Search className="w-4 h-4 text-zinc-400 flex-shrink-0" />
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search conversations... (Press Enter to open)"
            className="flex-1 bg-transparent outline-none text-[14px] text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500"
            aria-label="Search conversations"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors p-1"
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={() => setIsOpen(false)}
            className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors ml-1 p-1 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-label="Close history"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Session List */}
        <div className="overflow-y-auto custom-scrollbar" style={{ maxHeight: 'calc(100dvh - 180px)' }}>
          {groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 px-6 text-center">
              <MessageSquare className="w-8 h-8 text-zinc-300 dark:text-zinc-600 mb-3" />
              <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                {query ? 'No conversations match your search' : 'No conversations yet'}
              </p>
              <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">
                {query ? 'Try different keywords' : 'Your chats will appear here automatically'}
              </p>
            </div>
          ) : (
            <div className="py-1">
              {groups.map(({ label, items }) => (
                <div key={label}>
                  <div className="px-4 pt-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                    {label}
                  </div>
                  {items.map((session) => {
                    const isActive = session.id === activeSessionId;
                    return (
                      <button
                        key={session.id}
                        onClick={() => handleLoadSession(session)}
                        className={`group w-full flex items-center justify-between px-4 py-2.5 transition-colors text-left ${
                          isActive
                            ? 'bg-[#4140FD]/[0.08] dark:bg-[#4140FD]/15 hover:bg-[#4140FD]/[0.12]'
                            : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
                        }`}
                      >
                        <div className="flex-1 min-w-0 pr-2">
                          <div className="flex items-center gap-2">
                            <span
                              className={`text-[13.5px] font-medium truncate ${
                                isActive ? 'text-[#4140FD] dark:text-[#A39CF9] font-semibold' : 'text-zinc-800 dark:text-zinc-100'
                              }`}
                            >
                              {session.title}
                            </span>
                            {isActive && (
                              <span className="flex-shrink-0 flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.2 rounded-md bg-[#4140FD]/10 text-[#4140FD] dark:text-[#A39CF9]">
                                <Check className="w-2.5 h-2.5" />
                                Active
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <Clock className="w-3 h-3 text-zinc-400 flex-shrink-0" />
                            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                              {formatRelativeTime(session.updatedAt || session.createdAt)}
                            </span>
                            <span className="text-[11px] text-zinc-300 dark:text-zinc-600">·</span>
                            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                              {session.messages.length} message{session.messages.length !== 1 ? 's' : ''}
                            </span>
                          </div>
                        </div>
                        <button
                          onClick={(e) => handleDelete(e, session.id)}
                          className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-zinc-400 hover:text-red-500 transition-all flex-shrink-0 focus:opacity-100"
                          title="Delete conversation"
                          aria-label="Delete conversation"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        {groups.length > 0 && (
          <div className="px-4 py-2.5 border-t border-black/[0.05] dark:border-white/[0.05] flex items-center justify-between bg-zinc-50/50 dark:bg-zinc-900/40">
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
              {filtered.length} conversation{filtered.length !== 1 ? 's' : ''}
            </span>
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500 hidden sm:block">
              Press Enter to open top match · Esc to close
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
