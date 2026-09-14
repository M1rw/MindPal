import React from 'react';

export const SecuritySettingsTab: React.FC = () => (
  <div className="space-y-6">
    <div><h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Security</h2><p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">End-to-end security and in-memory credential storage.</p></div>
    <div className="p-4 rounded-2xl bg-gray-50 dark:bg-zinc-800/40 border border-gray-100 dark:border-zinc-800 space-y-2 text-xs text-gray-600 dark:text-gray-300"><p className="font-semibold text-gray-900 dark:text-gray-100">Security Architecture:</p><ul className="list-disc pl-5 space-y-1"><li>Session tokens are held strictly in memory and are never persisted in localStorage.</li><li>Firebase AppCheck verifies client legitimacy to prevent unauthorized traffic.</li><li>Clinical guardrails inspect all input and output text in real time.</li></ul></div>
  </div>
);
