import React from 'react';
import { X, LogOut } from 'lucide-react';

export interface SettingsNavTab {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface SettingsSidebarProps {
  navTabs: SettingsNavTab[];
  activeTab: string;
  onChangeTab: (tab: string) => void;
  onClose: () => void;
  onSignOut?: () => void;
  user?: { uid?: string } | null;
}

export const SettingsSidebar: React.FC<SettingsSidebarProps> = ({
  navTabs,
  activeTab,
  onChangeTab,
  onClose,
  onSignOut,
  user,
}) => (
  <aside className="w-[220px] flex-none bg-zinc-50 dark:bg-[#141416] border-r border-zinc-200 dark:border-zinc-800/80 p-3 hidden sm:flex flex-col justify-between">
    <div>
      <div className="flex items-center justify-between px-2 mb-3">
        <span className="text-sm font-bold tracking-tight text-gray-800 dark:text-gray-200">
          Settings
        </span>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-gray-200 dark:hover:bg-zinc-800 text-gray-500 dark:text-gray-400 transition-colors focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none"
          title="Close settings"
          type="button"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <nav className="flex flex-col gap-0.5 text-[13px]">
        {navTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onChangeTab(tab.id)}
              type="button"
              className={`flex items-center gap-2.5 px-3 py-2 rounded-xl font-medium transition-colors text-left focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none ${
                isActive
                  ? 'bg-[#4140FD] text-white'
                  : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </div>

    {user && (
      <button
        onClick={onSignOut}
        type="button"
        className="flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px] font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
      >
        <LogOut className="w-4 h-4" />
        <span>Sign Out</span>
      </button>
    )}
  </aside>
);
