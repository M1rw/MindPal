import React from 'react';
import type { FeaturesSettingsTabProps } from './types';

export const FeaturesSettingsTab: React.FC<FeaturesSettingsTabProps> = ({
  changelogData,
  onOpenWhatsNew,
}) => (
  <div className="space-y-6">
    <div>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Features & Releases</h2>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
        Latest updates and active platform capabilities.
      </p>
    </div>

    {changelogData?.entries && changelogData.entries.length > 0 ? (
      <div className="space-y-4">
        <div className="flex items-center justify-between p-4 rounded-2xl bg-[#4140FD]/10 dark:bg-[#6572F2]/15 border border-[#4140FD]/20">
          <div>
            <div className="text-sm font-semibold text-[#4140FD] dark:text-[#A39CF9]">
              MindPal {changelogData.current_version || '5.0'} Announcement
            </div>
            <div className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">
              View the official launch modal with interactive feature tour.
            </div>
          </div>
          <button
            type="button"
            onClick={onOpenWhatsNew}
            className="px-3.5 py-1.5 rounded-xl bg-[#4140FD] hover:bg-[#3231d6] text-white text-xs font-semibold shadow-sm active:scale-95 transition-all"
          >
            View What's New
          </button>
        </div>

        {changelogData.entries.map((item) => (
          <div
            key={item.version}
            className="p-4 rounded-2xl bg-gray-50 dark:bg-zinc-800/50 border border-gray-100 dark:border-zinc-800"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-bold px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">
                v{item.version}
              </span>
              {item.released_at && (
                <span className="text-[11px] text-gray-400">{item.released_at}</span>
              )}
            </div>
            <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mt-1">
              {item.title}
            </h4>
            {item.summary && (
              <p className="text-xs text-gray-600 dark:text-gray-300 mt-1 leading-relaxed">
                {item.summary}
              </p>
            )}
            {item.highlights && item.highlights.length > 0 && (
              <ul className="mt-2.5 list-disc pl-5 text-xs text-gray-600 dark:text-gray-400 space-y-1">
                {item.highlights.map((h, idx) => (
                  <li key={idx}>{h}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    ) : (
      <div className="text-xs text-gray-400">Loading release history…</div>
    )}
  </div>
);
