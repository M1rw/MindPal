import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Search, MessageSquare, Loader2 } from 'lucide-react';
import { useChatHistoryStore, useChatHistoryModalStore, useChatStore } from '../../../store';
import { Modal, ModalBody, ModalClose, ModalToolbar } from '../../ui/Modal';
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
  const closeHistory = useCallback(() => setIsOpen(false), [setIsOpen]);

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
      e.preventDefault();
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
    setActiveSessionId(null);
    setIsOpen(false);
  }, [clearMessages, setActiveSessionId, setIsOpen]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => {
      if (s.title.toLowerCase().includes(q)) return true;
      return s.messages.some((m) => m.content.toLowerCase().includes(q));
    });
  }, [sessions, query]);

  const groups = useMemo(() => groupSessions(filtered), [filtered]);

  return (
    <Modal
      open={isOpen}
      onClose={closeHistory}
      label="Chat history"
      size="lg"
      flush
      panelClassName="min-h-[min(24rem,70svh)] max-h-[min(80svh,36rem)] overscroll-contain"
    >
      <ModalToolbar>
        <Search className="w-4 h-4 text-content-muted flex-shrink-0" />
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search…"
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
            type="button"
            onClick={() => setQuery('')}
            className="text-xs font-medium text-content-muted hover:text-content-primary transition-colors px-1 py-1"
            aria-label="Clear search"
          >
            Clear
          </button>
        )}
        {query && <span aria-hidden="true" className="h-5 w-px bg-edge-subtle" />}
        <ModalClose onClick={closeHistory} label="Close history" />
      </ModalToolbar>

      <ModalBody className="custom-scrollbar">
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
      </ModalBody>
      {cloudError && groups.length > 0 ? (
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
      ) : null}
    </Modal>
  );
};
