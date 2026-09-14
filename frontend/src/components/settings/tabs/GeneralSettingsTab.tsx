import React from 'react';
import { STORAGE_KEYS } from '../../../constants/storage';
import type { SettingsTabContentProps } from './types';

export const GeneralSettingsTab: React.FC<SettingsTabContentProps> = ({ settings, updateSettings }) => (
  <div className="space-y-6">
    <div>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">General</h2>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
        Basic system preferences and theme controls.
      </p>
    </div>

    <div className="space-y-4">
      <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-zinc-800">
        <div>
          <span className="text-sm font-medium text-gray-800 dark:text-gray-200">Theme</span>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Choose your interface visual appearance.
          </p>
        </div>
        <div className="flex gap-1.5">
          {(['light', 'dark'] as const).map((theme) => (
            <button
              key={theme}
              onClick={() => {
                updateSettings({ theme });
                if (theme === 'dark') {
                  document.documentElement.classList.add('dark');
                  document.documentElement.classList.remove('light');
                  localStorage.setItem(STORAGE_KEYS.THEME, 'dark');
                } else {
                  document.documentElement.classList.remove('dark');
                  document.documentElement.classList.add('light');
                  localStorage.setItem(STORAGE_KEYS.THEME, 'light');
                }
              }}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium capitalize border transition-all ${
                (theme === 'dark' && document.documentElement.classList.contains('dark')) ||
                (theme === 'light' && !document.documentElement.classList.contains('dark'))
                  ? 'bg-[#4140FD] text-white border-[#4140FD]'
                  : 'border-gray-200 dark:border-zinc-700 hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-700 dark:text-gray-300'
              }`}
            >
              {theme}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-zinc-800">
        <div>
          <span className="text-sm font-medium text-gray-800 dark:text-gray-200">Sound Effects</span>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Subtle audio feedback for voice and actions.
          </p>
        </div>
        <input
          type="checkbox"
          checked={settings.soundEnabled}
          onChange={(e) => updateSettings({ soundEnabled: e.target.checked })}
          className="w-4 h-4 text-[#4140FD] rounded focus:ring-[#4140FD]"
        />
      </div>
    </div>
  </div>
);
