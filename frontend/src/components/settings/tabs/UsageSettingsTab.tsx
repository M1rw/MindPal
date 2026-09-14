import React from 'react';
import type { InsightsTabProps } from './types';

export const UsageSettingsTab: React.FC<InsightsTabProps> = ({ insights, loading, error }) => {
  if (loading) return <State title="Loading your usage snapshot…" />;
  if (error) return <State title="Your usage snapshot is temporarily unavailable. Please try again in a moment." error />;

  const reflectionsUsed = insights?.total_reflections ?? 0;
  const streakDays = insights?.reflection_streak_days ?? 0;
  return (
    <div className="space-y-6">
      <Header />
      <div className="p-4 rounded-2xl bg-gray-50 dark:bg-zinc-800/50 border border-gray-100 dark:border-zinc-800 space-y-4">
        <div className="flex justify-between items-center text-sm"><span className="font-medium text-gray-800 dark:text-gray-200">Tier</span><span className="px-2 py-0.5 rounded-md bg-[#EFF3FB] dark:bg-[#6572F2]/20 text-[#4140FD] dark:text-[#A39CF9] text-xs font-bold uppercase">Preview / Unlimited</span></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Metric label="Reflections used" value={reflectionsUsed} />
          <Metric label="Current streak" value={`${streakDays} days`} />
        </div>
        <div className="flex justify-between items-center text-xs text-gray-500 dark:text-gray-400"><span>Preview usage is currently informational.</span><span>Reset: Daily at 00:00 UTC</span></div>
        {reflectionsUsed === 0 && <div className="text-xs text-gray-500 dark:text-gray-400">No usage activity has been recorded yet. Once you start interacting with MindPal, this panel will reflect your activity.</div>}
      </div>
    </div>
  );
};

const Header: React.FC = () => <div><h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Usage & Quota</h2><p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Track your daily and monthly message limits.</p></div>;
const Metric: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => <div className="p-3 rounded-xl bg-white dark:bg-zinc-900/60 border border-gray-100 dark:border-zinc-800"><div className="text-[11px] uppercase tracking-wider text-gray-500 dark:text-gray-400">{label}</div><div className="mt-1 text-lg font-bold text-gray-900 dark:text-gray-100">{value}</div></div>;
const State: React.FC<{ title: string; error?: boolean }> = ({ title, error }) => <div className="space-y-6"><Header /><div className={`p-4 rounded-2xl border text-sm ${error ? 'border-red-100 dark:border-red-900/40 bg-red-50/60 dark:bg-red-950/20 text-red-700 dark:text-red-300' : 'bg-gray-50 dark:bg-zinc-800/50 border-gray-100 dark:border-zinc-800 text-gray-500 dark:text-gray-400'}`}>{title}</div></div>;
