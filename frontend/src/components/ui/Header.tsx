import React, { useEffect, useState } from 'react';
import { Moon, Sun, Flame, User, Brain, Plus } from 'lucide-react';
import { useAuthStore, useStreakStore, useSettingsStore, useChatStore } from '../../store';
import { EnvTag } from './EnvTag';

interface HeaderProps {
  onOpenMemory: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onOpenMemory }) => {
  const { user, openAuthModal } = useAuthStore();
  const { streak, setIsOpen: setStreakOpen } = useStreakStore();
  const { setIsOpen: setSettingsOpen } = useSettingsStore();
  const { clearMessages } = useChatStore();

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
      localStorage.setItem('mindpal_theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('mindpal_theme', 'light');
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
          className="flex items-center gap-2 group text-left focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none rounded-lg"
          title="Start new conversation"
        >
          <span className="text-xl font-medium tracking-tight text-gray-800 dark:text-gray-200">
            MindPal
          </span>
        </button>
        <EnvTag />
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-1 sm:gap-2 text-gray-600 dark:text-gray-300">
        {/* New Chat Button */}
        <button
          onClick={clearMessages}
          className="p-2 hover:bg-gemini-surface dark:hover:bg-gemini-darkSurface rounded-full transition-colors flex-shrink-0 focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none"
          title="New Chat"
          aria-label="New chat"
        >
          <Plus className="w-5 h-5" />
        </button>

        {/* Memory Profile Button */}
        <button
          onClick={onOpenMemory}
          className="p-2 hover:bg-gemini-surface dark:hover:bg-gemini-darkSurface rounded-full transition-colors flex-shrink-0 focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none"
          title="Memory Profile"
          aria-label="Memory profile"
        >
          <Brain className="w-5 h-5 text-[#4140FD]" />
        </button>

        {/* Theme Toggle Button */}
        <button
          id="theme-toggle-btn"
          onClick={toggleTheme}
          className="p-2 hover:bg-gemini-surface dark:hover:bg-gemini-darkSurface rounded-full transition-colors flex-shrink-0 focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none"
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label="Toggle theme"
        >
          {isDark ? <Sun className="w-5 h-5 text-amber-400" /> : <Moon className="w-5 h-5 text-gray-700" />}
        </button>

        {/* Streak Button */}
        <button
          id="streak-btn"
          onClick={() => setStreakOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 hover:bg-gemini-surface dark:hover:bg-gemini-darkSurface rounded-full transition-colors text-[14px] font-medium focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none"
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
          className="p-1.5 hover:bg-gemini-surface dark:hover:bg-gemini-darkSurface rounded-full transition-colors flex-shrink-0 focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none"
          title={user ? `${user.displayName || user.email || 'User'} — Settings` : 'Sign In'}
          aria-label={user ? 'Profile & Settings' : 'Sign in to sync'}
        >
          {user?.photoURL ? (
            <img
              src={user.photoURL}
              alt={user.displayName || 'Profile'}
              className="w-8 h-8 rounded-full border border-gray-300 dark:border-zinc-600 object-cover"
            />
          ) : user ? (
            <div className="w-8 h-8 rounded-full bg-[#4140FD] text-white flex items-center justify-center font-medium text-xs border border-[#6572F2]">
              {(user.displayName || user.email || 'U').charAt(0).toUpperCase()}
            </div>
          ) : (
            <div
              id="profile-avatar"
              className="w-8 h-8 rounded-full bg-gray-200 dark:bg-zinc-700 flex items-center justify-center text-gray-600 dark:text-gray-300 border border-gray-300 dark:border-zinc-600"
            >
              <User className="w-4 h-4" />
            </div>
          )}
        </button>
      </div>
    </header>
  );
};
