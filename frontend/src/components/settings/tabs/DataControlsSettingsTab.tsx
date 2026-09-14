import React from 'react';
import type { DataControlsTabProps } from './types';

export const DataControlsSettingsTab: React.FC<DataControlsTabProps> = ({ exporting, onExportData, onDeleteData }) => (
  <div className="space-y-6">
    <div><h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Data Controls</h2><p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Export or delete your personal conversations and memories.</p></div>
    <div className="space-y-3">
      <div className="flex items-center justify-between p-4 rounded-2xl bg-gray-50 dark:bg-zinc-800/40 border border-gray-100 dark:border-zinc-800"><div><h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Export Data</h4><p className="text-xs text-gray-500 dark:text-gray-400">Download a JSON copy of all memories and conversations.</p></div><button type="button" disabled={exporting} onClick={onExportData} className="px-3.5 py-2 rounded-xl bg-gray-200 dark:bg-zinc-700 hover:bg-gray-300 dark:hover:bg-zinc-600 text-xs font-semibold flex items-center gap-1.5 transition-colors"><span>{exporting ? 'Exporting…' : 'Export JSON'}</span></button></div>
      <div className="flex items-center justify-between p-4 rounded-2xl bg-red-50/50 dark:bg-red-950/20 border border-red-100 dark:border-red-900/30"><div><h4 className="text-sm font-semibold text-red-600 dark:text-red-400">Delete All Data</h4><p className="text-xs text-gray-500 dark:text-gray-400">Permanently erase your chat logs and memory graph.</p></div><button type="button" onClick={onDeleteData} className="px-3.5 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"><span>Delete</span></button></div>
    </div>
  </div>
);
