import React from 'react';

export const MentalHealthSettingsTab: React.FC = () => (
  <div className="space-y-6">
    <div>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Mental Health & Safety</h2>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
        Protocols designed for supportive, grounded, and clinical safety.
      </p>
    </div>

    <div className="p-4 rounded-2xl bg-zinc-50 dark:bg-[#1C1C20] border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-900 dark:text-zinc-100 space-y-2">
      <div className="font-semibold flex items-center gap-1.5">
        <span className="inline-block text-[#4140FD] dark:text-[#A39CF9]">●</span>
        24/7 Immediate Crisis Support
      </div>
      <p>
        MindPal is a supportive AI companion, not an emergency medical service. If you are in distress or need immediate help:
      </p>
      <ul className="list-disc pl-5 space-y-1">
        <li>
          <strong>US:</strong> Call or text <strong>988</strong> (Suicide & Crisis Lifeline)
        </li>
        <li>
          <strong>UK:</strong> Call <strong>111</strong> or text <strong>SHOUT to 85258</strong>
        </li>
        <li>
          <strong>Global:</strong> Visit <strong>findahelpline.com</strong> for free local confidential support
        </li>
      </ul>
    </div>

    <div className="space-y-4">
      <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-zinc-800">
        <div>
          <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
            Proactive Grounding Exercises
          </span>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Offer 4-7-8 breathing or somatic grounding when detecting high anxiety.
          </p>
        </div>
        <span className="text-xs font-semibold px-2 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300">
          Active
        </span>
      </div>
    </div>
  </div>
);
