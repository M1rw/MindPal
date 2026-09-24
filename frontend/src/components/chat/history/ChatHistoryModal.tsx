/**
 * Search: MindPal's command palette (Ctrl/Cmd + K), modelled on ChatGPT's.
 *
 * One box for everything: actions (new chat, live voice, memory, settings,
 * theme) and conversations, searched by title and by what was said, with the
 * matching line shown. Fully keyboard driven: arrows move, Enter opens, Esc
 * closes.
 *
 * Only the person's chosen quick actions show up front ("More actions" opens
 * the rest in place); "Customize" lets them pin, unpin and reorder, remembered
 * on this device. Chats can be pinned to a group at the top, synced with the
 * account. Rename, pin and delete stay on each conversation row; deleting asks.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  Brain,
  ChevronDown,
  ChevronUp,
  CornerDownLeft,
  Database,
  Flame,
  Gauge,
  Loader2,
  MessageSquare,
  Moon,
  Pin,
  RotateCcw,
  Search,
  Settings,
  Sliders,
  SlidersHorizontal,
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
import {
  MAX_PINNED_ACTIONS,
  moveAction,
  resetQuickActions,
  togglePinnedAction,
  useQuickActions,
} from '../../../store/palette.ts';
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

/** A selectable row, in on-screen order. */
type PaletteItem =
  | { kind: 'action'; action: PaletteAction }
  | { kind: 'more' }
  | { kind: 'chat'; session: ChatSession };

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
  const togglePinned = useChatHistoryStore((s) => s.togglePinned);
  const setActiveSessionId = useChatHistoryStore((s) => s.setActiveSessionId);
  const guestSessionCount = useChatHistoryStore((s) => s.guestSessionCount);
  const importGuestSessions = useChatHistoryStore((s) => s.importGuestSessions);
  const liveVoiceEnabled = useFlagsStore((s) => Boolean(s.flags.voice_enabled));
  const quickActionIds = useQuickActions();

  const setMessages = useChatStore((s) => s.setMessages);

  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [showMore, setShowMore] = useState(false);
  const [customizing, setCustomizing] = useState(false);
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
      setShowMore(false);
      setCustomizing(false);
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
  const searching = terms.length > 0;
  const byId = useMemo(() => new Map(actions.map((a) => [a.id, a])), [actions]);
  // Pinned actions in the person's order (ones unavailable here, like voice
  // when it is off, are skipped), then everything else.
  const pinnedActions = useMemo(
    () => quickActionIds.map((id) => byId.get(id)).filter((a): a is PaletteAction => Boolean(a)),
    [quickActionIds, byId],
  );
  const otherActions = useMemo(
    () => actions.filter((a) => !quickActionIds.includes(a.id)),
    [actions, quickActionIds],
  );

  const shownActions = useMemo(() => {
    if (searching) return actions.filter((a) => matchesAll(`${a.label} ${a.keywords}`, terms));
    if (customizing || showMore) return [...pinnedActions, ...otherActions];
    return pinnedActions;
  }, [searching, actions, terms, customizing, showMore, pinnedActions, otherActions]);
  const offerMore = !searching && !customizing && otherActions.length > 0;

  const matches = useMemo(() => searchChats(sessions, query), [sessions, query]);
  const groups = useMemo(() => {
    if (searching) {
      if (!matches.length) return [];
      const ordered = [...matches.filter((m) => m.session.pinned), ...matches.filter((m) => !m.session.pinned)];
      return [{ label: 'Chats', items: ordered.map((m) => m.session) }];
    }
    const pinned = sessions.filter((s) => s.pinned);
    const rest = groupSessions(sessions.filter((s) => !s.pinned));
    return pinned.length ? [{ label: 'Pinned', items: pinned }, ...rest] : rest;
  }, [searching, matches, sessions]);
  const snippets = useMemo(() => {
    const map: Record<string, string> = {};
    for (const m of matches) if (m.snippet) map[m.session.id] = m.snippet;
    return map;
  }, [matches]);

  const items = useMemo<PaletteItem[]>(
    () => [
      ...shownActions.map((action) => ({ kind: 'action' as const, action })),
      ...(offerMore ? [{ kind: 'more' as const }] : []),
      ...(customizing ? [] : groups.flatMap((g) => g.items.map((session) => ({ kind: 'chat' as const, session })))),
    ],
    [shownActions, offerMore, customizing, groups],
  );
  const chatIndex = useMemo(() => {
    const map: Record<string, number> = {};
    items.forEach((item, index) => {
      if (item.kind === 'chat') map[item.session.id] = index;
    });
    return map;
  }, [items]);
  const moreIndex = items.findIndex((item) => item.kind === 'more');

  // A new search starts at the top.
  useEffect(() => setHighlight(0), [query, customizing]);
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
      if (customizing) {
        togglePinnedAction(action.id);
        return;
      }
      setIsOpen(false);
      action.run();
    },
    [customizing, togglePinnedAction, setIsOpen],
  );

  const activate = useCallback(
    (item: PaletteItem | undefined) => {
      if (!item) return;
      if (item.kind === 'action') runAction(item.action);
      else if (item.kind === 'more') setShowMore((open) => !open);
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

  const handleTogglePin = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      togglePinned(id);
    },
    [togglePinned],
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
  const noResults = searching && items.length === 0;
  const pinnedCount = pinnedActions.length;

  const renderAction = (action: PaletteAction, index: number) => {
    const Icon = action.icon;
    const active = current === index;
    const pinned = quickActionIds.includes(action.id);
    const pinnedPosition = quickActionIds.indexOf(action.id);
    return (
      <div
        key={action.id}
        id={`palette-item-${index}`}
        role="option"
        aria-selected={active}
        data-palette-index={index}
        onMouseMove={() => setHighlight(index)}
        className={cn('palette-row palette-row--action mx-2', active && 'is-highlighted', customizing && 'is-customizing')}
      >
        <button
          type="button"
          className="palette-row__main"
          onClick={() => runAction(action)}
          aria-label={customizing ? `${pinned ? 'Unpin' : 'Pin'} ${action.label}` : action.label}
        >
          <span className="palette-row__icon" aria-hidden="true">
            <Icon className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1 truncate text-left text-sm text-content-primary">
            <HighlightedText text={action.label} query={query} />
          </span>
          {!customizing && action.shortcut ? <kbd className="palette-kbd">{action.shortcut}</kbd> : null}
          {!customizing ? (
            <CornerDownLeft className="palette-row__enter h-3.5 w-3.5 flex-none" aria-hidden="true" />
          ) : null}
        </button>
        {customizing ? (
          <div className="flex flex-none items-center gap-0.5">
            {pinned ? (
              <>
                <button
                  type="button"
                  className="palette-tool"
                  onClick={() => moveAction(action.id, -1)}
                  disabled={pinnedPosition <= 0}
                  aria-label={`Move ${action.label} up`}
                  title="Move up"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="palette-tool"
                  onClick={() => moveAction(action.id, 1)}
                  disabled={pinnedPosition >= pinnedCount - 1}
                  aria-label={`Move ${action.label} down`}
                  title="Move down"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
              </>
            ) : null}
            <button
              type="button"
              className={cn('palette-tool', pinned && 'is-on')}
              onClick={() => togglePinnedAction(action.id)}
              disabled={!pinned && quickActionIds.length >= MAX_PINNED_ACTIONS}
              aria-pressed={pinned}
              aria-label={pinned ? `Remove ${action.label} from quick actions` : `Add ${action.label} to quick actions`}
              title={pinned ? 'Remove from quick actions' : 'Add to quick actions'}
            >
              <Pin className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
      </div>
    );
  };

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
        <kbd className="palette-kbd">Esc</kbd>
        <span className="sm:hidden">
          <ModalClose onClick={closePalette} label="Close search" />
        </span>
      </ModalToolbar>

      <ModalBody className="custom-scrollbar">
        <div ref={bodyRef} id="command-palette-list" role="listbox" aria-label="Results">
          {shownActions.length > 0 || offerMore || customizing ? (
            <div className="pt-2">
              <div className="palette-section flex items-center justify-between gap-2 pr-3">
                <span>{searching ? 'Actions' : customizing ? 'Choose your quick actions' : 'Quick actions'}</span>
                {!searching ? (
                  <span className="flex items-center gap-1 normal-case tracking-normal">
                    {customizing ? (
                      <button type="button" className="palette-link" onClick={resetQuickActions}>
                        <RotateCcw className="h-3 w-3" aria-hidden="true" /> Reset
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={cn('palette-link', customizing && 'is-primary')}
                      onClick={() => setCustomizing((on) => !on)}
                      aria-pressed={customizing}
                    >
                      {customizing ? (
                        'Done'
                      ) : (
                        <>
                          <SlidersHorizontal className="h-3 w-3" aria-hidden="true" /> Customize
                        </>
                      )}
                    </button>
                  </span>
                ) : null}
              </div>
              {customizing ? (
                <p className="px-5 pb-2 text-xs text-content-muted">
                  Pin up to {MAX_PINNED_ACTIONS} to show here; the rest stay one search away.
                </p>
              ) : null}
              {shownActions.map((action, index) => renderAction(action, index))}
              {offerMore ? (
                <button
                  type="button"
                  id={`palette-item-${moreIndex}`}
                  role="option"
                  aria-selected={current === moreIndex}
                  aria-expanded={showMore}
                  data-palette-index={moreIndex}
                  onMouseMove={() => setHighlight(moreIndex)}
                  onClick={() => setShowMore((open) => !open)}
                  className={cn('palette-more mx-2', current === moreIndex && 'is-highlighted')}
                >
                  {showMore ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  {showMore ? 'Show fewer' : `More actions (${otherActions.length})`}
                </button>
              ) : null}
            </div>
          ) : null}

          {customizing ? null : isLoadingCloud && groups.length === 0 && !searching ? (
            <SkeletonHistoryList count={4} />
          ) : cloudError && groups.length === 0 && !searching ? (
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
          ) : groups.length === 0 && !searching ? (
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
              onTogglePin={handleTogglePin}
            />
          )}
        </div>
      </ModalBody>

      {cloudError && groups.length > 0 && !customizing ? (
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
        <span><kbd className="palette-kbd">↵</kbd> {customizing ? 'Pin / unpin' : 'Open'}</span>
        <span><kbd className="palette-kbd">Esc</kbd> Close</span>
        <span className="ml-auto text-brand-primary">{shortcutLabel('K')}</span>
      </div>
    </Modal>
  );
};
