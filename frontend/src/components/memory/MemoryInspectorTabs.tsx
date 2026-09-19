import React from 'react';
import { cn } from '../../utils/ui/cn';

interface MemoryInspectorTabsProps {
  activeTab: 'summary' | 'atoms';
  atomsCount: number;
  onChangeTab: (tab: 'summary' | 'atoms') => void;
}

const tabClass = (active: boolean) =>
  cn(
    'relative flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium',
    'transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary',
    active ? 'bg-surface-card text-content-primary shadow-card' : 'text-content-secondary hover:text-content-primary'
  );

export const MemoryInspectorTabs: React.FC<MemoryInspectorTabsProps> = ({
  activeTab,
  atomsCount,
  onChangeTab,
}) => (
  <div className="px-6 py-2 border-b border-edge-subtle">
    <div
      role="tablist"
      aria-label="Memory sections"
      className="flex w-fit items-center gap-0.5 rounded-full bg-surface-sunken p-0.5"
    >
      <button
        type="button"
        role="tab"
        id="memory-tab-summary"
        aria-controls="memory-panel-summary"
        aria-selected={activeTab === 'summary'}
        onClick={() => onChangeTab('summary')}
        className={tabClass(activeTab === 'summary')}
      >
        Summary
      </button>
      <button
        type="button"
        role="tab"
        id="memory-tab-atoms"
        aria-controls="memory-panel-atoms"
        aria-selected={activeTab === 'atoms'}
        onClick={() => onChangeTab('atoms')}
        className={tabClass(activeTab === 'atoms')}
      >
        <span>Saved facts</span>
        {atomsCount > 0 ? (
          <span className="rounded-full bg-brand-subtle px-1.5 text-xs font-medium text-brand-primary">
            {atomsCount}
          </span>
        ) : null}
      </button>
    </div>
  </div>
);
