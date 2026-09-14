import React, { useEffect, useState } from 'react';
import { Moon, Sun, Flame, User, Plus, History } from 'lucide-react';
import { useAuthStore, useStreakStore, useSettingsStore, useChatStore, useChatHistoryModalStore } from '../../store';
import { STORAGE_KEYS } from '../../constants/storage';
import { EnvTag } from './EnvTag';

interface HeaderProps {
  onOpenMemory?: () => void;
}

export const Header: React.FC<HeaderProps> = () => {
  const { user, openAuthModal } = useAuthStore();
  const { streak, setIsOpen: setStreakOpen } = useStreakStore();
  const { setIsOpen: setSettingsOpen } = useSettingsStore();
  const { clearMessages } = useChatStore();
  const { setIsOpen: setHistoryOpen } = useChatHistoryModalStore();

  const [isDark, setIsDark] = useState<boolean>(() => {
    if (typeof document !== 'undefined') {
      return document.documentElement.classList.contains('dark');
    }
    return true;
  });

  useEffect(() => {
    // Sync initial theme
    const dark = document.documentElement.classList.contains('dark');
    setIsDark(dark);
  }, []);

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
    if (user) {
      setSettingsOpen(true);
    } else {
      openAuthModal();
    }
  };

  return (
    <header
      id="header"
      className="flex items-center justify-between px-5 pt-safe-top pb-3 transition-all duration-300 flex-none z-20 bg-transparent absolute top-0 w-full"
    >
      {/* Brand & Environment Tag */}
      <div className="flex items-center gap-2">
        <button
          onClick={clearMessages}
          className="flex items-center gap-2 group text-left focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none rounded-lg"
          title="Start new conversation"
        >
          <span className="text-xl font-medium tracking-tight text-content-primary">
            MindPal
          </span>
        </button>
        <EnvTag />
      </div>

      {/* Action Buttons */}
      <nav aria-label="MindPal actions" className="flex items-center gap-1 sm:gap-2 text-content-secondary">
        {/* New Chat Button */}
        <button
          onClick={clearMessages}
          className="p-2 hover:bg-surface-subtle rounded-full transition-all flex-shrink-0 active:scale-95 focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
          title="New Chat"
          aria-label="New chat"
        >
          <Plus className="w-5 h-5" />
        </button>

        {/* History Button */}
        <button
          onClick={() => setHistoryOpen(true)}
          className="p-2 hover:bg-surface-subtle rounded-full transition-all flex-shrink-0 active:scale-95 focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
          title="Chat History"
          aria-label="Open chat history"
        >
          <History className="w-5 h-5" />
        </button>

        {/* Theme Toggle Button */}
        <button
          id="theme-toggle-btn"
          onClick={toggleTheme}
          className="p-2 hover:bg-surface-subtle rounded-full transition-all flex-shrink-0 active:scale-95 focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label="Toggle theme"
        >
          {isDark ? <Sun className="w-5 h-5 text-amber-400" /> : <Moon className="w-5 h-5 text-zinc-700" />}
        </button>

        {/* Streak Button */}
        <button
          id="streak-btn"
          onClick={() => setStreakOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 hover:bg-surface-subtle rounded-full transition-all active:scale-95 text-sm font-medium focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
          title="View Journey & Streak"
          aria-label="View daily streak progress"
        >
          <span id="streak-counter">{streak.count}</span>
          <Flame className="w-4 h-4 text-orange-500 dark:text-orange-400 fill-orange-500/20" />
        </button>

        {/* Profile / Auth Button */}
        <button
          id="profile-btn"
          onClick={handleProfileClick}
          className="p-1.5 hover:bg-surface-subtle rounded-full transition-all flex-shrink-0 active:scale-95 focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
          title={user ? `${user.displayName || user.email || 'User'} — Settings` : 'Sign In'}
          aria-label={user ? 'Profile & Settings' : 'Sign in to sync'}
        >
          {user?.photoURL ? (
            <img
              src={user.photoURL}
              alt={user.displayName || 'Profile'}
              className="w-8 h-8 rounded-full border border-edge-default object-cover"
            />
          ) : user ? (
            <div className="w-8 h-8 rounded-full bg-brand-primary text-white flex items-center justify-center font-medium text-xs border border-brand-secondary shadow-sm">
              {(user.displayName || user.email || 'U').charAt(0).toUpperCase()}
            </div>
          ) : (
            <div
              id="profile-avatar"
              className="w-8 h-8 rounded-full bg-surface-subtle flex items-center justify-center text-content-secondary border border-edge-default"
            >
              <User className="w-4 h-4" />
            </div>
          )}
        </button>
      </nav>
    </header>
  );
};
