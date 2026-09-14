import React from 'react';

interface MemoryInspectorTabsProps {
  activeTab: 'summary' | 'atoms';
  atomsCount: number;
  onChangeTab: (tab: 'summary' | 'atoms') => void;
}

export const MemoryInspectorTabs: React.FC<MemoryInspectorTabsProps> = ({
  activeTab,
  atomsCount,
  onChangeTab,
}) => (
  <div className="flex items-center gap-2 px-6 pt-3 border-b border-edge-subtle">
    <button
      type="button"
      onClick={() => onChangeTab('summary')}
      className={`pb-2.5 text-xs font-semibold border-b-2 transition-colors ${
        activeTab === 'summary'
          ? 'border-brand-primary text-brand-primary'
          : 'border-transparent text-content-secondary hover:text-content-primary'
      }`}
    >
      Narrative Summary
    </button>
    <button
      type="button"
      onClick={() => onChangeTab('atoms')}
      className={`pb-2.5 text-xs font-semibold border-b-2 transition-colors flex items-center gap-1.5 ${
        activeTab === 'atoms'
          ? 'border-brand-primary text-brand-primary'
          : 'border-transparent text-content-secondary hover:text-content-primary'
      }`}
    >
      <span>Durable Memory Atoms</span>
      {atomsCount > 0 && (
        <span className="px-1.5 py-0.2 rounded-full bg-brand-subtle text-brand-primary text-2xs font-semibold">
          {atomsCount}
        </span>
      )}
    </button>
  </div>
);
