import React from 'react';
import type { InsightsTabProps } from './types';

export const AnalyticsSettingsTab: React.FC<InsightsTabProps> = ({ insights, loading, error }) => {
  if (loading) {
    return (
      <div className="space-y-6">
        <Header />
        <StatusCard>Loading your reflection analytics…</StatusCard>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <Header />
        <StatusCard error>We could not load your analytics right now. Please try again in a moment.</StatusCard>
      </div>
    );
  }

  const totalReflections = insights?.total_reflections ?? 0;
  const streakDays = insights?.reflection_streak_days ?? 0;
  const phq9 = insights?.clinical_scores?.phq9 ?? null;
  const gad7 = insights?.clinical_scores?.gad7 ?? null;

  return (
    <div className="space-y-6">
      <Header />
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric label="Total reflections" value={totalReflections} />
        <Metric label="Reflection streak" value={`${streakDays}d`} />
        <Metric
          label="Clinical check-in"
          value={phq9 !== null || gad7 !== null
            ? `${phq9 !== null ? `PHQ-9 ${phq9}` : 'PHQ-9 unavailable'} • ${gad7 !== null ? `GAD-7 ${gad7}` : 'GAD-7 unavailable'}`
            : 'No clinical scores yet'}
        />
      </div>
      <div className="p-4 rounded-2xl bg-gray-50 dark:bg-zinc-800/40 border border-gray-100 dark:border-zinc-800">
        <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-3 uppercase tracking-wider">
          Reflection summary
        </div>
        <div className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
          {totalReflections > 0
            ? `You have completed ${totalReflections} reflection${totalReflections === 1 ? '' : 's'} so far, with a ${streakDays}-day consistency streak. This is a useful baseline for tracking mood and resilience trends over time.`
            : 'No reflections have been recorded yet. Once you start using MindPal, your activity summary will appear here.'}
        </div>
      </div>
    </div>
  );
};

const Header: React.FC = () => (
  <div>
    <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Reflection Analytics</h2>
    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
      Your emotional check-ins and reflection frequency over time.
    </p>
  </div>
);

const StatusCard: React.FC<React.PropsWithChildren<{ error?: boolean }>> = ({ children, error }) => (
  <div className={`p-4 rounded-2xl border text-sm ${error
    ? 'border-red-100 dark:border-red-900/40 bg-red-50/60 dark:bg-red-950/20 text-red-700 dark:text-red-300'
    : 'bg-gray-50 dark:bg-zinc-800/40 border-gray-100 dark:border-zinc-800 text-gray-500 dark:text-gray-400'}`}>
    {children}
  </div>
);

const Metric: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="p-4 rounded-2xl bg-gray-50 dark:bg-zinc-800/40 border border-gray-100 dark:border-zinc-800">
    <div className="text-[11px] uppercase tracking-wider text-gray-500 dark:text-gray-400">{label}</div>
    <div className="mt-2 text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</div>
  </div>
);
