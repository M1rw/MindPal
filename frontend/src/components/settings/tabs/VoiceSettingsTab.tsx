import React from 'react';

export const VoiceSettingsTab: React.FC = () => (
  <div className="space-y-6">
    <div>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Voice & Audio</h2>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
        Configure spoken voice model and speech synthesis.
      </p>
    </div>

    <div className="space-y-4">
      <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-zinc-800">
        <div>
          <span className="text-sm font-medium text-gray-800 dark:text-gray-200">Voice Model</span>
          <p className="text-xs text-gray-500 dark:text-gray-400">Gemini Live audio engine</p>
        </div>
        <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Advanced Neural</span>
      </div>

      <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-zinc-800">
        <div>
          <span className="text-sm font-medium text-gray-800 dark:text-gray-200">Language</span>
          <p className="text-xs text-gray-500 dark:text-gray-400">Automatic multilingual detection</p>
        </div>
        <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Auto-detect</span>
      </div>
    </div>
  </div>
);
