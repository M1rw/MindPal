import React from 'react';
import { LogOut } from 'lucide-react';
import { ModalClose } from '../ui/Modal';
import { settingsNavItemClass } from './SettingsPrimitives';

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
  <aside className="w-[220px] flex-none bg-surface-sunken border-r border-edge-subtle p-3 hidden sm:flex flex-col justify-between">
    <div>
      <div className="flex items-center justify-between px-2 mb-4">
        <span className="text-sm font-semibold tracking-tight text-content-primary">Settings</span>
        <ModalClose onClick={onClose} label="Close settings" />
      </div>

      <nav className="flex flex-col gap-0.5 text-sm">
        {navTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onChangeTab(tab.id)}
              type="button"
              aria-current={isActive ? 'page' : undefined}
              className={settingsNavItemClass(isActive)}
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
        className="flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-medium text-feedback-danger hover:bg-feedback-dangerSubtle transition-colors duration-150 ease-out focus-visible:ring-2 focus-visible:ring-feedback-danger focus-visible:outline-none"
      >
        <LogOut className="w-4 h-4" />
        <span>Sign out</span>
      </button>
    )}
  </aside>
);
