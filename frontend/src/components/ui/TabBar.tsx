import React, { useRef } from 'react';
import { MessageSquare, Eye } from 'lucide-react';

export type AppTab = 'chat' | 'presence';

interface TabBarProps {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  showPresenceTab?: boolean;
}

const TABS: { id: AppTab; label: string; icon: React.ReactNode }[] = [
  { id: 'chat', label: 'Chat', icon: <MessageSquare className="h-3.5 w-3.5" /> },
  { id: 'presence', label: 'Presence', icon: <Eye className="h-3.5 w-3.5" /> },
];

export const TabBar: React.FC<TabBarProps> = ({ activeTab, onTabChange, showPresenceTab = false }) => {
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

  if (tabs.length < 2) {
    return null;
  }

  return (
    <div
      role="tablist"
      aria-label="MindPal modes"
      className={`mode-tabs mode-tabs--at-${Math.max(0, tabs.findIndex((tab) => tab.id === activeTab))}`}
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
            aria-label={tab.label}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onTabChange(tab.id)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
            className={isActive ? 'mode-tabs__tab is-active' : 'mode-tabs__tab'}
          >
            {tab.icon}
            <span className="mode-tabs__label">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
};
