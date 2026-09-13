import React from 'react';
import { MessageSquare, Eye } from 'lucide-react';

export type AppTab = 'chat' | 'presence';

interface TabBarProps {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
}

const TABS: { id: AppTab; label: string; icon: React.ReactNode; badge?: string }[] = [
  { id: 'chat',     label: 'Chat',     icon: <MessageSquare className="w-4 h-4" /> },
  { id: 'presence', label: 'Presence', icon: <Eye className="w-4 h-4" />, badge: 'New' },
];

export const TabBar: React.FC<TabBarProps> = ({ activeTab, onTabChange }) => {
  return (
    <div
      role="tablist"
      aria-label="MindPal modes"
      className="flex items-center gap-1 bg-black/[0.04] dark:bg-white/[0.06] rounded-xl p-0.5"
    >
      {TABS.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            role="tab"
            aria-selected={isActive}
            aria-controls={`tabpanel-${tab.id}`}
            onClick={() => onTabChange(tab.id)}
            className={[
              'relative flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm font-medium',
              'transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4140FD]',
              isActive
                ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-sm'
                : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200',
            ].join(' ')}
          >
            {tab.icon}
            <span>{tab.label}</span>
            {tab.badge && !isActive && (
              <span className="bg-[#4140FD]/10 dark:bg-[#6572F2]/20 text-[#4140FD] dark:text-[#A39CF9] text-[9px] px-1.5 py-0.5 rounded-full font-semibold uppercase leading-none">
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
