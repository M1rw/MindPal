import React from 'react';
import { SettingsBlock, SettingsHeader } from '../SettingsPrimitives';
import { useWellnessTimeline } from '../../../hooks/session/useWellnessTimeline.ts';
import {
  WellnessCrisisResources,
  WellnessLoading,
  WellnessOverview,
} from '../wellness';
import { WELLNESS_DISCLAIMER } from '../../../utils/wellness/reflect.ts';
import type { WellnessTabProps } from './types.ts';

export const MentalHealthSettingsTab: React.FC<WellnessTabProps> = ({ onSignIn }) => {
  const { data, loading, error, signedIn, refresh } = useWellnessTimeline(true);

  return (
    <div className="space-y-8">
      <SettingsHeader
        title="Mental health"
        description="A reflection of mood, problems, and life events from what you've told MindPal — not a diagnosis."
      />

      <div>
        <SettingsBlock title="How to read this">
          <p>{data?.disclaimer || WELLNESS_DISCLAIMER}</p>
        </SettingsBlock>

        <WellnessCrisisResources />

        {loading ? <WellnessLoading /> : null}

        {error ? (
          <SettingsBlock title="Couldn't load this reflection" last>
            <p>
              {error} This isn't live monitoring. If you need help now, use the resources above.
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
          <WellnessOverview data={data} variant="mental-health" signedIn={signedIn} onSignIn={onSignIn} />
        ) : null}
      </div>
    </div>
  );
};
