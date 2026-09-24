/**
 * Search: MindPal's command palette (Ctrl/Cmd + K), modelled on ChatGPT's.
 *
 * One box for everything: actions (new chat, live voice, memory, settings,
 * theme) and conversations, searched by title and by what was said, with the
 * matching line shown. Fully keyboard driven: arrows move, Enter opens, Esc
 * closes. Rename and delete stay on each conversation row; deleting asks first.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  AudioLines,
  Brain,
  CornerDownLeft,
  Database,
  Flame,
  Gauge,
  Loader2,
  MessageSquare,
  Moon,
  Search,
  Settings,
  Sliders,
  SquarePen,
  Sun,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  useChatHistoryStore,
  useChatHistoryModalStore,
  useChatStore,
  useFlagsStore,
  useMemoryStore,
  useSettingsStore,
  useStreakStore,
  useVoiceStore,
} from '../../../store';
import { Modal, ModalBody, ModalClose, ModalToolbar } from '../../ui/Modal';
import { SkeletonHistoryList } from '../../ui/Skeleton';
import { HighlightedText } from '../../ui/HighlightedText';
import type { ChatSession } from '../../../types';
import { ChatHistoryGroups } from './ChatHistoryGroups';
import { confirmAction } from '../../../store/confirm.ts';
import { startNewChat } from '../../../utils/chat/appActions';
import { isDarkTheme, toggleTheme } from '../../../utils/ui/theme';
import { matchesAll, searchChats, searchTerms } from '../../../utils/ui/search';
import { shortcutLabel } from '../../../utils/ui/shortcuts';
import { cn } from '../../../utils/ui/cn';

export function groupSessions(sessions: ChatSession[]): { label: string; items: ChatSession[] }[] {
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

interface PaletteAction {
  id: string;
  label: string;
  /** Extra words the action is found by. */
  keywords: string;
  icon: React.ComponentType<{ className?: string }>;
  shortcut?: string;
  run: () => void;
}

/** A selectable row: an action or a conversation, in on-screen order. */
type PaletteItem = { kind: 'action'; action: PaletteAction } | { kind: 'chat'; session: ChatSession };

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
  const guestSessionCount = useChatHistoryStore((s) => s.guestSessionCount);
  const importGuestSessions = useChatHistoryStore((s) => s.importGuestSessions);
  const liveVoiceEnabled = useFlagsStore((s) => Boolean(s.flags.voice_enabled));

  const setMessages = useChatStore((s) => s.setMessages);

  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [highlight, setHighlight] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closePalette = useCallback(() => setIsOpen(false), [setIsOpen]);

  useEffect(() => {
    if (isOpen) {
      // Only auto-focus the search field on desktop (pointer: fine) — on iOS/Android
      // auto-focusing immediately raises the virtual keyboard and collapses the modal.
      if (window.matchMedia('(pointer: fine)').matches) {
        searchRef.current?.focus({ preventScroll: true });
      }
      useChatHistoryStore.getState().loadCloudSessions();
    } else {
      setQuery('');
      setEditingId(null);
      setHighlight(0);
    }
  }, [isOpen]);

  // Every action closes the palette first, so what it opens is on top.
  const actions = useMemo<PaletteAction[]>(() => {
    const openSettings = (tab: string) => () => {
      const settings = useSettingsStore.getState();
      settings.setActiveTab(tab);
      settings.setIsOpen(true);
    };
    const dark = isDarkTheme();
    const list: PaletteAction[] = [
      {
        id: 'new-chat',
        label: 'New chat',
        keywords: 'start fresh conversation clear',
        icon: SquarePen,
        shortcut: shortcutLabel('O', { shift: true }),
        run: () => void startNewChat(),
      },
    ];
    if (liveVoiceEnabled) {
      list.push({
        id: 'live-voice',
        label: 'Start live voice',
        keywords: 'call talk speak microphone',
        icon: AudioLines,
        run: () => useVoiceStore.getState().setIsActive(true),
      });
    }
    list.push(
      {
        id: 'memory',
        label: 'Open memory',
        keywords: 'remember facts summary what mindpal knows',
        icon: Brain,
        run: () => useMemoryStore.getState().setIsOpen(true),
      },
      {
        id: 'settings',
        label: 'Settings',
        keywords: 'preferences options general',
        icon: Settings,
        run: openSettings('general'),
      },
      {
        id: 'personalization',
        label: 'Personalization',
        keywords: 'reply style warmth concise detailed',
        icon: Sliders,
        run: openSettings('personalization'),
      },
      {
        id: 'usage',
        label: 'Usage',
        keywords: 'credits limits quota voice minutes',
        icon: Gauge,
        run: openSettings('usage'),
      },
      {
        id: 'data',
        label: 'Data controls',
        keywords: 'export download delete privacy',
        icon: Database,
        run: openSettings('data'),
      },
      {
        id: 'theme',
        label: dark ? 'Switch to light mode' : 'Switch to dark mode',
        keywords: 'theme appearance dark light',
        icon: dark ? Sun : Moon,
        run: () => void toggleTheme(),
      },
      {
        id: 'streak',
        label: 'Days you showed up',
        keywords: 'streak progress',
        icon: Flame,
        run: () => useStreakStore.getState().setIsOpen(true),
      },
    );
    if (guestSessionCount > 0) {
      list.push({
        id: 'import-guest',
        label: `Add ${guestSessionCount} chat${guestSessionCount === 1 ? '' : 's'} from this device to my account`,
        keywords: 'import guest before signed in',
        icon: Upload,
        run: () => void importGuestSessions(),
      });
    }
    return list;
    // Rebuilt when the palette opens, so the theme label is current.
  }, [liveVoiceEnabled, guestSessionCount, importGuestSessions, isOpen]);

  const terms = useMemo(() => searchTerms(query), [query]);
  const visibleActions = useMemo(
    () => (terms.length ? actions.filter((a) => matchesAll(`${a.label} ${a.keywords}`, terms)) : actions),
    [actions, terms],
  );
  const matches = useMemo(() => searchChats(sessions, query), [sessions, query]);
  const groups = useMemo(
    () =>
      terms.length
        ? matches.length
          ? [{ label: 'Chats', items: matches.map((m) => m.session) }]
          : []
        : groupSessions(sessions),
    [terms, matches, sessions],
  );
  const snippets = useMemo(() => {
    const map: Record<string, string> = {};
    for (const m of matches) if (m.snippet) map[m.session.id] = m.snippet;
    return map;
  }, [matches]);

  const items = useMemo<PaletteItem[]>(
    () => [
      ...visibleActions.map((action) => ({ kind: 'action' as const, action })),
      ...groups.flatMap((g) => g.items.map((session) => ({ kind: 'chat' as const, session }))),
    ],
    [visibleActions, groups],
  );
  const chatIndex = useMemo(() => {
    const map: Record<string, number> = {};
    items.forEach((item, index) => {
      if (item.kind === 'chat') map[item.session.id] = index;
    });
    return map;
  }, [items]);

  // A new search starts at the top.
  useEffect(() => setHighlight(0), [query]);
  const current = Math.min(highlight, Math.max(0, items.length - 1));

  useEffect(() => {
    bodyRef.current
      ?.querySelector(`[data-palette-index="${current}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const handleLoadSession = useCallback(
    (session: ChatSession) => {
      setMessages(session.messages);
      setActiveSessionId(session.id);
      setIsOpen(false);
    },
    [setMessages, setActiveSessionId, setIsOpen],
  );

  const runAction = useCallback(
    (action: PaletteAction) => {
      setIsOpen(false);
      action.run();
    },
    [setIsOpen],
  );

  const activate = useCallback(
    (item: PaletteItem | undefined) => {
      if (!item) return;
      if (item.kind === 'action') runAction(item.action);
      else handleLoadSession(item.session);
    },
    [runAction, handleLoadSession],
  );

  const handleDelete = useCallback(
    async (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      const title = sessions.find((s) => s.id === id)?.title || 'this chat';
      const ok = await confirmAction({
        title: 'Delete this chat?',
        message: `“${title}” will be removed from your history${
          useChatHistoryStore.getState().owner === 'guest' ? ' on this device' : ' and your account'
        }. This can’t be undone.`,
        confirmLabel: 'Delete',
        tone: 'danger',
        icon: Trash2,
      });
      if (ok) deleteSession(id);
    },
    [deleteSession, sessions],
  );

  const handleStartRename = useCallback((e: React.MouseEvent, session: ChatSession) => {
    e.preventDefault();
    e.stopPropagation();
    setEditingId(session.id);
    setEditingTitle(session.title);
  }, []);

  const handleSaveRename = useCallback(
    (id: string) => {
      if (editingTitle.trim()) {
        renameSession(id, editingTitle.trim());
      }
      setEditingId(null);
    },
    [editingTitle, renameSession],
  );

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!items.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((current + 1) % items.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((current - 1 + items.length) % items.length);
    } else if (event.key === 'Home' && event.ctrlKey) {
      event.preventDefault();
      setHighlight(0);
    } else if (event.key === 'End' && event.ctrlKey) {
      event.preventDefault();
      setHighlight(items.length - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      activate(items[current]);
    }
  };

  const highlighted = items[current];
  const highlightedChatId = highlighted?.kind === 'chat' ? highlighted.session.id : null;
  const noResults = terms.length > 0 && items.length === 0;

  return (
    <Modal
      open={isOpen}
      onClose={closePalette}
      label="Search chats and actions"
      size="lg"
      flush
      swipeable
      panelClassName="command-palette min-h-[min(20rem,50svh)] max-h-[min(80svh,38rem)] overscroll-contain"
    >
      <ModalToolbar className="gap-3 px-4 py-3">
        <Search className="w-4 h-4 text-content-muted flex-shrink-0" />
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search chats and actions…"
          className="flex-1 bg-transparent outline-none text-sm text-content-primary placeholder-content-muted"
          aria-label="Search chats and actions"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-list"
          aria-activedescendant={items.length ? `palette-item-${current}` : undefined}
          aria-autocomplete="list"
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
        <kbd className="palette-kbd hidden sm:inline-flex">Esc</kbd>
        <span className="sm:hidden">
          <ModalClose onClick={closePalette} label="Close search" />
        </span>
      </ModalToolbar>

      <ModalBody className="custom-scrollbar">
        <div ref={bodyRef} id="command-palette-list" role="listbox" aria-label="Results">
          {visibleActions.length > 0 ? (
            <div className="pt-2">
              <div className="palette-section">{terms.length ? 'Actions' : 'Quick actions'}</div>
              {visibleActions.map((action, index) => {
                const Icon = action.icon;
                const active = current === index;
                return (
                  <button
                    key={action.id}
                    id={`palette-item-${index}`}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-palette-index={index}
                    onMouseMove={() => setHighlight(index)}
                    onClick={() => runAction(action)}
                    className={cn('palette-row mx-2', active && 'is-highlighted')}
                  >
                    <Icon className="h-4 w-4 flex-none text-content-secondary" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-left text-sm text-content-primary">
                      <HighlightedText text={action.label} query={query} />
                    </span>
                    {action.shortcut ? <kbd className="palette-kbd">{action.shortcut}</kbd> : null}
                    <CornerDownLeft className="palette-row__enter h-3.5 w-3.5 flex-none" aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          ) : null}

          {isLoadingCloud && groups.length === 0 && !terms.length ? (
            <SkeletonHistoryList count={4} />
          ) : cloudError && groups.length === 0 && !terms.length ? (
            <div className="flex flex-col items-center justify-center py-10 px-6 text-center">
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
          ) : noResults ? (
            <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
              <Search className="w-7 h-7 text-content-muted mb-3" />
              <p className="text-sm font-medium text-content-secondary">Nothing matches “{query.trim()}”</p>
              <p className="text-xs text-content-muted mt-1">Try other words. Chats are searched by title and by what was said.</p>
            </div>
          ) : groups.length === 0 && !terms.length ? (
            <p className="px-5 py-8 text-center text-xs text-content-muted">
              Your conversations will appear here.
            </p>
          ) : (
            <ChatHistoryGroups
              groups={groups}
              activeSessionId={activeSessionId}
              editingId={editingId}
              editingTitle={editingTitle}
              onLoadSession={handleLoadSession}
              onStartRename={handleStartRename}
              onDelete={(e, id) => void handleDelete(e, id)}
              onSaveRename={handleSaveRename}
              onEditingTitleChange={setEditingTitle}
              onEditingIdChange={setEditingId}
              highlightedId={highlightedChatId}
              snippets={snippets}
              query={query}
              onHighlight={(id) => setHighlight(chatIndex[id] ?? current)}
              paletteIndex={chatIndex}
            />
          )}
        </div>
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

      <div className="palette-footer hidden sm:flex" aria-hidden="true">
        <span><kbd className="palette-kbd">↑</kbd><kbd className="palette-kbd">↓</kbd> Navigate</span>
        <span><kbd className="palette-kbd">↵</kbd> Open</span>
        <span><kbd className="palette-kbd">Esc</kbd> Close</span>
        <span className="ml-auto text-brand-primary">{shortcutLabel('K')}</span>
      </div>
    </Modal>
  );
};
