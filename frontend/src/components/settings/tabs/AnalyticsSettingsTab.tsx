import React from 'react';
import { SettingsBlock, SettingsHeader } from '../SettingsPrimitives';
import { useWellnessTimeline } from '../../../hooks/session/useWellnessTimeline.ts';
import { WellnessLoading, WellnessOverview } from '../wellness';
import { WELLNESS_DISCLAIMER } from '../../../utils/wellness/reflect.ts';
import type { WellnessTabProps } from './types.ts';

export const AnalyticsSettingsTab: React.FC<WellnessTabProps> = ({ onSignIn }) => {
  const { data, loading, error, signedIn, refresh } = useWellnessTimeline(true);

  return (
    <div className="space-y-8">
      <SettingsHeader
        title="Analytics"
        description="Activity and themes from the same reflection as Mental health. Not a screening-score dashboard."
      />

      <div>
        <SettingsBlock title="What this counts">
          <p>{data?.disclaimer || WELLNESS_DISCLAIMER}</p>
          <p>
            Signed-in accounts load this from /api/user/wellness-timeline. Guests see this device
            only. Mood over time, heavier and lighter days, and how things were affecting you live
            on the Mental health tab. Streaks in the header count calendar days you sent a message.
            They are not a mood score. Chat credits are on the Usage tab.
          </p>
        </SettingsBlock>

        {loading ? <WellnessLoading /> : null}

        {error ? (
          <SettingsBlock title="Couldn't load activity" last>
            <p>
              {error} If you need help now, crisis resources are on the Mental health tab.
            </p>
            <button
              type="button"
              onClick={refresh}
              className="text-sm font-medium text-content-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded-lg"
            >
              Try again
            </button>
          </SettingsBlock>
        ) : null}

        {!loading && !error && data ? (
          <WellnessOverview data={data} variant="analytics" signedIn={signedIn} onSignIn={onSignIn} />
        ) : null}
      </div>
    </div>
  );
};
