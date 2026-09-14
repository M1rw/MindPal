import React from 'react';
import type { SettingsTabContentProps, UserPersonalization } from './types';

export const PersonalizationSettingsTab: React.FC<SettingsTabContentProps> = ({
  settings,
  updateSettings,
  onOpenMemory,
}) => (
  <div className="space-y-6">
    <div>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Personalization</h2>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Customize how MindPal talks with you.</p>
    </div>
    <div className="space-y-4">
      <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-zinc-800">
        <div><span className="text-sm font-medium text-gray-800 dark:text-gray-200">Base Tone & Style</span><p className="text-xs text-gray-500 dark:text-gray-400">Conversational balance</p></div>
        <select value={settings.personalization.baseStyle} onChange={(e) => updateSettings({ personalization: { ...settings.personalization, baseStyle: e.target.value as UserPersonalization['baseStyle'] } })} className="bg-gray-100 dark:bg-zinc-800 px-3 py-1.5 rounded-xl text-xs outline-none">
          <option value="concise">Concise</option><option value="balanced">Balanced</option><option value="detailed">Detailed</option>
        </select>
      </div>
      <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-zinc-800">
        <div><span className="text-sm font-medium text-gray-800 dark:text-gray-200">Warmth & Empathy</span><p className="text-xs text-gray-500 dark:text-gray-400">Emotional validation level</p></div>
        <select value={settings.personalization.warmth} onChange={(e) => updateSettings({ personalization: { ...settings.personalization, warmth: e.target.value as UserPersonalization['warmth'] } })} className="bg-gray-100 dark:bg-zinc-800 px-3 py-1.5 rounded-xl text-xs outline-none">
          <option value="warm">Warm</option><option value="neutral">Neutral</option><option value="direct">Direct</option>
        </select>
      </div>
      <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-zinc-800">
        <div><span className="text-sm font-medium text-gray-800 dark:text-gray-200">Memory Profile</span><p className="text-xs text-gray-500 dark:text-gray-400">View and manage what MindPal remembers about your goals and traits.</p></div>
        <button type="button" onClick={() => onOpenMemory?.()} className="px-3 py-1.5 rounded-xl bg-[#EFF3FB] dark:bg-[#6572F2]/20 text-[#4140FD] dark:text-[#A39CF9] text-xs font-semibold hover:bg-[#E2E6F0] transition-colors">Manage Memory</button>
      </div>
    </div>
  </div>
);
