import React, { useEffect, useRef, useState } from 'react';
import { Moon, Sun, Flame, User, Plus, History, MoreHorizontal } from 'lucide-react';
import {
  useAuthStore,
  useChatHistoryModalStore,
  useChatHistoryStore,
  useChatStore,
  useSettingsStore,
  useStreakStore,
} from '../../store';
import { STORAGE_KEYS } from '../../constants/storage';
import { POPOVER_EXIT_MS, useOverlayPresence } from '../../hooks/ui/useOverlayPresence';
import { popoverPanelClass } from '../../utils/ui/overlay';
import { EnvTag } from './EnvTag';
import { TabBar, type AppTab } from './TabBar';

const iconBtnClass =
  'header-compact-btn inline-flex h-9 w-9 items-center justify-center rounded-full text-content-secondary transition-colors duration-150 ease-out hover:bg-surface-subtle hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary';

const menuItemClass =
  'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-content-primary transition-colors duration-150 ease-out hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary';

interface HeaderProps {
  activeTab?: AppTab;
  onTabChange?: (tab: AppTab) => void;
  showPresenceTab?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab = 'chat',
  onTabChange,
  showPresenceTab = false,
}) => {
  const { user } = useAuthStore();
  const { streak, setIsOpen: setStreakOpen } = useStreakStore();
  const { setIsOpen: setSettingsOpen } = useSettingsStore();
  const { messages, isGenerating, stopGeneration, clearMessages } = useChatStore();
  const setActiveSessionId = useChatHistoryStore((state) => state.setActiveSessionId);
  const { setIsOpen: setHistoryOpen } = useChatHistoryModalStore();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const { mounted: moreMounted, visible: moreVisible } = useOverlayPresence(moreOpen, POPOVER_EXIT_MS);

  const [isDark, setIsDark] = useState<boolean>(() => {
    if (typeof document !== 'undefined') {
      return document.documentElement.classList.contains('dark');
    }
    return true;
  });

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains('dark'));
  }, []);

  useEffect(() => {
    if (!moreOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) {
        setMoreOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    const media = window.matchMedia('(min-width: 640px)');
    const onViewport = () => {
      if (media.matches) setMoreOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    media.addEventListener('change', onViewport);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      media.removeEventListener('change', onViewport);
    };
  }, [moreOpen]);

  const toggleTheme = () => {
    const nextDark = !isDark;
    setIsDark(nextDark);
    if (nextDark) {
      document.documentElement.classList.add('dark');
      document.documentElement.classList.remove('light');
      localStorage.setItem(STORAGE_KEYS.THEME, 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      document.documentElement.classList.add('light');
      localStorage.setItem(STORAGE_KEYS.THEME, 'light');
    }
  };

  const handleProfileClick = () => {
    setSettingsOpen(true);
  };

  const handleNewChat = () => {
    if (messages.length === 0) return;

    const confirmed = window.confirm(
      'Start a new conversation? You can reopen this thread from History.'
    );
    if (!confirmed) return;

    if (isGenerating) {
      stopGeneration();
    }
    clearMessages();
    setActiveSessionId(null);
  };

  const openHistory = () => {
    setMoreOpen(false);
    setHistoryOpen(true);
  };

  const openStreak = () => {
    setMoreOpen(false);
    setStreakOpen(true);
  };

  const onToggleTheme = () => {
    setMoreOpen(false);
    toggleTheme();
  };

  const themeLabel = isDark ? 'Switch to light mode' : 'Switch to dark mode';
  const profileLabel = user ? 'Profile & Settings' : 'Settings';

  return (
    <header
      id="header"
      className="sticky top-0 z-20 flex flex-none items-center gap-2 px-3 pb-2.5 pt-safe-top sm:px-5 bg-surface-canvas/90 backdrop-blur-md transition-colors duration-200 ease-out"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <p className="select-none text-xl font-medium tracking-tight text-content-primary">
          MindPal
        </p>
        <EnvTag />
      </div>

      {showPresenceTab && onTabChange ? (
        <TabBar activeTab={activeTab} onTabChange={onTabChange} showPresenceTab={showPresenceTab} />
      ) : null}

      <nav aria-label="MindPal actions" className="ml-auto flex items-center gap-1 text-content-secondary">
        <button
          type="button"
          onClick={handleNewChat}
          className={iconBtnClass}
          title="New chat"
          aria-label="New chat"
        >
          <Plus className="h-4 w-4" />
        </button>

        <button
          type="button"
          onClick={openHistory}
          className={`${iconBtnClass} hidden sm:inline-flex`}
          title="Chat history"
          aria-label="Open chat history"
        >
          <History className="h-4 w-4" />
        </button>

        <button
          type="button"
          id="theme-toggle-btn"
          onClick={toggleTheme}
          className={`${iconBtnClass} hidden sm:inline-flex`}
          title={themeLabel}
          aria-label="Toggle theme"
        >
          {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>

        <button
          type="button"
          id="streak-btn"
          onClick={openStreak}
          className={`${iconBtnClass} hidden w-auto gap-1 px-2 sm:inline-flex`}
          title="Days you showed up"
          aria-label="View daily streak progress"
        >
          <span id="streak-counter" className="text-xs font-medium tabular-nums">
            {streak.count}
          </span>
          <Flame
            className={
              streak.count > 0
                ? 'h-4 w-4 fill-brand-primary/20 text-brand-primary'
                : 'h-4 w-4 text-content-muted'
            }
          />
        </button>

        <div ref={moreRef} className="relative sm:hidden">
          <button
            type="button"
            onClick={() => setMoreOpen((open) => !open)}
            className={iconBtnClass}
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            aria-controls="header-more-menu"
            title="More actions"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>

          {moreMounted ? (
            <div
              id="header-more-menu"
              role="menu"
              aria-label="More actions"
              className={popoverPanelClass(
                moreVisible,
                'absolute right-0 top-full z-50 mt-1.5 w-52 rounded-xl border border-edge-subtle bg-surface-card p-1.5 shadow-modal'
              )}
            >
              <button type="button" role="menuitem" onClick={openHistory} className={menuItemClass} aria-label="Open chat history">
                <History className="h-4 w-4 text-content-secondary" />
                <span>Chat history</span>
              </button>
              <button type="button" role="menuitem" onClick={onToggleTheme} className={menuItemClass} aria-label="Toggle theme">
                {isDark ? <Sun className="h-4 w-4 text-content-secondary" /> : <Moon className="h-4 w-4 text-content-secondary" />}
                <span>{isDark ? 'Light mode' : 'Dark mode'}</span>
              </button>
              <button type="button" role="menuitem" onClick={openStreak} className={menuItemClass} aria-label="View daily streak progress">
                <Flame
                  className={
                    streak.count > 0
                      ? 'h-4 w-4 fill-brand-primary/20 text-brand-primary'
                      : 'h-4 w-4 text-content-muted'
                  }
                />
                <span>Days · {streak.count}</span>
              </button>
            </div>
          ) : null}
        </div>

        <button
          type="button"
          id="profile-btn"
          onClick={handleProfileClick}
          className={`${iconBtnClass} p-0.5`}
          title={user ? `${user.displayName || user.email || 'User'} — Settings` : 'Settings'}
          aria-label={profileLabel}
        >
          {user?.photoURL ? (
            <img
              src={user.photoURL}
              alt={user.displayName || 'Profile'}
              className="h-8 w-8 rounded-full border border-edge-default object-cover"
            />
          ) : user ? (
            <div className="flex h-8 w-8 items-center justify-center rounded-full border border-brand-secondary bg-brand-primary text-xs font-medium text-white shadow-sm">
              {(user.displayName || user.email || 'U').charAt(0).toUpperCase()}
            </div>
          ) : (
            <div
              id="profile-avatar"
              className="flex h-8 w-8 items-center justify-center rounded-full border border-edge-default bg-surface-subtle text-content-secondary"
            >
              <User className="h-3.5 w-3.5" />
            </div>
          )}
        </button>
      </nav>
    </header>
  );
};
