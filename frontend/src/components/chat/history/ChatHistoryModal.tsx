import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Search, X, MessageSquare, Loader2, Plus } from 'lucide-react';
import { useChatHistoryStore, useChatHistoryModalStore, useChatStore } from '../../../store';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { SkeletonHistoryList } from '../../ui/Skeleton';
import type { ChatSession } from '../../../types';
import { ChatHistoryGroups } from './ChatHistoryGroups';

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
  const isOpen = useChatHistoryModalStore((s) => s.isOpen);
  const setIsOpen = useChatHistoryModalStore((s) => s.setIsOpen);

  const sessions = useChatHistoryStore((s) => s.sessions);
  const activeSessionId = useChatHistoryStore((s) => s.activeSessionId);
  const isLoadingCloud = useChatHistoryStore((s) => s.isLoadingCloud);
  const cloudError = useChatHistoryStore((s) => s.cloudError);
  const deleteSession = useChatHistoryStore((s) => s.deleteSession);
  const renameSession = useChatHistoryStore((s) => s.renameSession);
  const setActiveSessionId = useChatHistoryStore((s) => s.setActiveSessionId);

  const setMessages = useChatStore((s) => s.setMessages);
  const clearMessages = useChatStore((s) => s.clearMessages);

  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // WCAG 2.1 AA Keyboard Focus Trap
  const modalCardRef = useFocusTrap<HTMLDivElement>({
    isOpen,
    onClose: () => setIsOpen(false),
    autoFocus: true,
  });

  useEffect(() => {
    if (isOpen) {
      searchRef.current?.focus({ preventScroll: true });
      useChatHistoryStore.getState().loadCloudSessions();
    } else {
      setQuery('');
      setEditingId(null);
    }
  }, [isOpen]);

  const handleLoadSession = useCallback(
    (session: ChatSession) => {
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

  const handleStartRename = useCallback(
    (e: React.MouseEvent, session: ChatSession) => {
      e.stopPropagation();
      setEditingId(session.id);
      setEditingTitle(session.title);
    },
    []
  );

  const handleSaveRename = useCallback(
    (id: string) => {
      if (editingTitle.trim()) {
        renameSession(id, editingTitle.trim());
      }
      setEditingId(null);
    },
    [editingTitle, renameSession]
  );

  const handleNewChat = useCallback(() => {
    clearMessages();
    setIsOpen(false);
  }, [clearMessages, setIsOpen]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => {
      if (s.title.toLowerCase().includes(q)) return true;
      return s.messages.some((m) => m.content.toLowerCase().includes(q));
    });
  }, [sessions, query]);

  const groups = useMemo(() => groupSessions(filtered), [filtered]);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered.length > 0) {
        handleLoadSession(filtered[0]);
      }
    }
  };

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center p-4 transition-all duration-200 ${
        isOpen ? 'opacity-100 pointer-events-auto visible' : 'opacity-0 pointer-events-none invisible'
      }`}
      role="dialog"
      aria-modal="true"
      aria-label="Chat history"
      aria-hidden={!isOpen}
    >
      {/* High-speed isolated backdrop */}
      <div
        onClick={() => setIsOpen(false)}
        className={`absolute inset-0 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 ease-out ${
          isOpen ? 'opacity-100' : 'opacity-0'
        }`}
      />

      {/* GPU Accelerated Modal Card with Focus Trap */}
      <div
        ref={modalCardRef}
        className={`relative w-full max-w-lg bg-surface-card rounded-2xl specular-card shadow-modal overflow-hidden border border-edge-subtle transform transition-all duration-200 ease-out flex flex-col ${
          isOpen ? 'scale-100 translate-y-0 opacity-100' : 'scale-[0.98] -translate-y-2 opacity-0'
        }`}
        style={{
          maxHeight: 'calc(100dvh - 100px)',
          willChange: 'transform, opacity',
        }}
      >
        {/* Search Bar & Header Controls */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-edge-subtle flex-shrink-0">
          <Search className="w-4 h-4 text-content-muted flex-shrink-0" />
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search conversations... (Press Enter to open)"
            className="flex-1 bg-transparent outline-none text-sm text-content-primary placeholder-content-muted"
            aria-label="Search conversations"
          />
          {isLoadingCloud && (
            <div className="flex items-center gap-1.5 text-xs text-brand-primary animate-pulse">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span className="hidden sm:inline">Syncing</span>
            </div>
          )}
          {query && (
            <button
              onClick={() => setQuery('')}
              className="text-content-muted hover:text-content-primary transition-colors p-1 rounded-lg"
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={handleNewChat}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-brand-subtle hover:bg-brand-primary/20 text-brand-primary transition-all active:scale-95"
            title="Start new conversation"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New</span>
          </button>
          <button
            onClick={() => setIsOpen(false)}
            className="text-content-muted hover:text-content-primary transition-colors ml-1 p-1 rounded-lg hover:bg-surface-subtle"
            aria-label="Close history"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Session List */}
        <div className="overflow-y-auto custom-scrollbar flex-1" style={{ maxHeight: 'calc(100dvh - 180px)' }}>
          {isLoadingCloud && groups.length === 0 ? (
            <SkeletonHistoryList count={4} />
          ) : cloudError && groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 px-6 text-center">
              <MessageSquare className="w-8 h-8 text-rose-500/70 mb-3" />
              <p className="text-sm font-medium text-content-primary">Cloud history unavailable</p>
              <p className="text-xs text-content-muted mt-1 mb-4">Your local conversations are safe. Retry the sync when you are ready.</p>
              <button
                type="button"
                onClick={() => useChatHistoryStore.getState().loadCloudSessions()}
                className="px-4 py-2 rounded-xl text-xs font-medium bg-brand-primary text-white hover:bg-brand-hover transition-transform active:scale-95 shadow-sm"
              >
                Retry sync
              </button>
            </div>
          ) : groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 px-6 text-center">
              <MessageSquare className="w-8 h-8 text-content-muted mb-3" />
              <p className="text-sm font-medium text-content-secondary">
                {query ? 'No conversations match your search' : 'No conversations yet'}
              </p>
              <p className="text-xs text-content-muted mt-1 mb-4">
                {query ? 'Try different keywords' : 'Your saved conversations and reflections will appear here'}
              </p>
              {!query && (
                <button
                  type="button"
                  onClick={handleNewChat}
                  className="px-4 py-2 rounded-xl text-xs font-medium bg-brand-primary text-white hover:bg-brand-hover transition-transform active:scale-95 shadow-sm"
                >
                  Start your first conversation
                </button>
              )}
            </div>
          ) : (
            <ChatHistoryGroups
              groups={groups}
              activeSessionId={activeSessionId}
              editingId={editingId}
              editingTitle={editingTitle}
              onLoadSession={handleLoadSession}
              onStartRename={handleStartRename}
              onDelete={handleDelete}
              onSaveRename={handleSaveRename}
              onEditingTitleChange={setEditingTitle}
              onEditingIdChange={setEditingId}
            />
          )}
        </div>
        {cloudError && groups.length > 0 && (
          <div className="flex items-center justify-between gap-3 border-t border-edge-subtle bg-amber-500/5 px-4 py-2.5 text-xs text-content-secondary">
            <span>{cloudError}</span>
            <button
              type="button"
              onClick={() => useChatHistoryStore.getState().loadCloudSessions()}
              className="flex-shrink-0 font-semibold text-brand-primary hover:text-brand-hover"
            >
              Retry sync
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
