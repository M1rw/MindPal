import React, { useRef } from 'react';
import { MessageSquare, Eye } from 'lucide-react';

export type AppTab = 'chat' | 'presence';

interface TabBarProps {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  showPresenceTab?: boolean;
}

const TABS: { id: AppTab; label: string; icon: React.ReactNode; badge?: string }[] = [
  { id: 'chat',     label: 'Chat',     icon: <MessageSquare className="w-4 h-4" /> },
  { id: 'presence', label: 'Presence', icon: <Eye className="w-4 h-4" />, badge: 'New' },
];

export const TabBar: React.FC<TabBarProps> = ({ activeTab, onTabChange, showPresenceTab = true }) => {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabs = showPresenceTab ? TABS : TABS.filter((tab) => tab.id === 'chat');

  const moveFocusToTab = (index: number) => {
    const nextTab = tabRefs.current[index];
    if (!nextTab) return;
    nextTab.focus();
    onTabChange(tabs[index].id);
  };

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      moveFocusToTab((index + 1) % tabs.length);
      return;
    }

    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocusToTab((index - 1 + tabs.length) % tabs.length);
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      moveFocusToTab(0);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      moveFocusToTab(tabs.length - 1);
    }
  };

  return (
    <div
      role="tablist"
      aria-label="MindPal modes"
      className="flex items-center gap-1 bg-surface-sunken border border-edge-subtle rounded-xl p-0.5"
    >
      {tabs.map((tab, index) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            id={`tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={`tabpanel-${tab.id}`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onTabChange(tab.id)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
            className={[
              'relative flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm font-medium',
              'transition-all duration-150 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary',
              isActive
                ? 'bg-surface-card text-content-primary shadow-card specular-card'
                : 'text-content-secondary hover:text-content-primary',
            ].join(' ')}
          >
            {tab.icon}
            <span>{tab.label}</span>
            {tab.badge && (
              <span className="bg-brand-subtle text-brand-primary text-2xs px-1.5 py-0.5 rounded-full font-semibold uppercase leading-none">
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
