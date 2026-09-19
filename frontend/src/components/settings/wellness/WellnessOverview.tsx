import React from 'react';
import { SettingsBlock, settingsPrimaryButtonClass } from '../SettingsPrimitives';
import { Skeleton } from '../../ui/Skeleton';
import { WellnessActivityChart, WellnessMoodChart, formatWellnessDay } from './WellnessCharts';
import type { WellnessTimeline } from '../../../types/index.ts';

export const WellnessCrisisResources: React.FC = () => (
  <SettingsBlock title="If you need help now">
    <p>
      MindPal cannot provide emergency or medical care. If you are in distress or might hurt
      yourself, contact a crisis service in your area.
    </p>
    <ul className="list-disc pl-5 space-y-1.5">
      <li>
        US: call or text{' '}
        <a href="tel:988" className="font-medium text-content-primary hover:underline">
          988
        </a>
      </li>
      <li>
        UK: call{' '}
        <a href="tel:111" className="font-medium text-content-primary hover:underline">
          111
        </a>{' '}
        or text SHOUT to 85258
      </li>
      <li>
        Other regions:{' '}
        <a
          href="https://findahelpline.com"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-content-primary hover:underline"
        >
          findahelpline.com
        </a>
      </li>
    </ul>
  </SettingsBlock>
);

export const WellnessLoading: React.FC = () => (
  <div className="space-y-3 py-5" aria-busy="true" aria-live="polite">
    <span className="sr-only">Loading your reflection</span>
    <Skeleton className="h-3 w-40" />
    <Skeleton className="h-24 w-full" />
    <Skeleton className="h-3 w-56" />
    <Skeleton className="h-16 w-full" />
  </div>
);

export const WellnessOverview: React.FC<{
  data: WellnessTimeline;
  variant: 'mental-health' | 'analytics';
  signedIn: boolean;
  onSignIn: () => void;
}> = ({ data, variant, signedIn, onSignIn }) => {
  const showMood = variant === 'mental-health';
  const moodTimeline = data.mood_timeline ?? [];
  const activity = data.activity ?? [];
  const themes = data.themes ?? [];
  const events = data.events ?? [];
  const hasMood = moodTimeline.length > 0;
  const hasActivity = activity.length > 0;
  const hasThemes = themes.length > 0;
  const hasEvents = events.length > 0;
  const heavier = data.highlights?.heavier_day ?? null;
  const lighter = data.highlights?.lighter_day ?? null;

  if (data.empty) {
    return (
      <SettingsBlock title="Nothing to reflect yet" last>
        <p>
          {signedIn
            ? "MindPal can show mood and events here after you've talked about them and they're saved with your account."
            : "MindPal can show mood and events here after you've talked about them. On this device that means local chats and saved guest facts. Sign in to include account memory and synced chats."}
        </p>
        {!signedIn ? (
          <button type="button" onClick={onSignIn} className={settingsPrimaryButtonClass}>
            Sign in
          </button>
        ) : null}
      </SettingsBlock>
    );
  }

  return (
    <div>
      <SettingsBlock title="Source">
        <p>{data.source_label}</p>
        {data.range ? (
          <p>
            {formatWellnessDay(data.range.start)}
            {data.range.start !== data.range.end ? ` – ${formatWellnessDay(data.range.end)}` : ''}
          </p>
        ) : null}
        {!signedIn ? (
          <button type="button" onClick={onSignIn} className={settingsPrimaryButtonClass}>
            Sign in for account history
          </button>
        ) : null}
      </SettingsBlock>

      {data.crisis_note ? (
        <SettingsBlock title="Crisis language">
          <p>{data.crisis_note}</p>
        </SettingsBlock>
      ) : null}

      {showMood ? (
        <SettingsBlock title="Mood over time">
          {hasMood ? (
            <>
              <p>Coarse labels from your words: heavier, mixed, or lighter. Not a 0–100 score.</p>
              <WellnessMoodChart points={moodTimeline} />
            </>
          ) : (
            <p>
              No mood language in what you wrote during this range. Activity and themes still appear
              when you mentioned them.
            </p>
          )}
        </SettingsBlock>
      ) : null}

      {showMood && (heavier || lighter) ? (
        <SettingsBlock title="Heavier and lighter days">
          {heavier ? (
            <div className="space-y-1">
              <p className="font-medium text-content-primary">
                {heavier.label} · {formatWellnessDay(heavier.date)}
              </p>
              {heavier.snippet ? <p>From your words: “{heavier.snippet}”</p> : null}
            </div>
          ) : null}
          {lighter ? (
            <div className="space-y-1">
              <p className="font-medium text-content-primary">
                {lighter.label} · {formatWellnessDay(lighter.date)}
              </p>
              {lighter.snippet ? <p>From your words: “{lighter.snippet}”</p> : null}
            </div>
          ) : null}
        </SettingsBlock>
      ) : null}

      <SettingsBlock title={variant === 'analytics' ? 'Activity over time' : 'When you wrote'} last={!hasThemes && !hasEvents && variant === 'analytics'}>
        {hasActivity ? (
          <>
            {variant === 'analytics' ? (
              <p>Days you sent a message, from the same source as Mental health. Not a streak score.</p>
            ) : (
              <p>Days you sent a message. Counts only.</p>
            )}
            <WellnessActivityChart points={activity} />
          </>
        ) : (
          <p>No dated messages in this reflection yet.</p>
        )}
      </SettingsBlock>

      {hasThemes ? (
        <SettingsBlock title="Recurring themes" last={!hasEvents && !(showMood && hasEvents)}>
          <ul className="space-y-3">
            {themes.map((theme) => (
              <li key={theme.id}>
                <p className="font-medium text-content-primary">
                  {theme.label}
                  <span className="font-normal text-content-secondary">
                    {' '}
                    · {theme.mentions} {theme.mentions === 1 ? 'mention' : 'mentions'}
                    {theme.last_seen ? ` · last ${formatWellnessDay(theme.last_seen)}` : ''}
                  </span>
                </p>
                {theme.snippet ? <p>From your words: “{theme.snippet}”</p> : null}
              </li>
            ))}
          </ul>
        </SettingsBlock>
      ) : null}

      {hasEvents && showMood ? (
        <SettingsBlock title="Life events" last>
          <ul className="space-y-3">
            {events.map((event) => (
              <li key={event.id}>
                <p className="font-medium text-content-primary">
                  {event.label}
                  {event.date ? (
                    <span className="font-normal text-content-secondary">
                      {' '}
                      · showed up around {formatWellnessDay(event.date)}
                    </span>
                  ) : (
                    <span className="font-normal text-content-secondary"> · saved in memory</span>
                  )}
                </p>
                {event.snippet ? <p>From your words: “{event.snippet}”</p> : null}
              </li>
            ))}
          </ul>
        </SettingsBlock>
      ) : null}

      {variant === 'analytics' && hasEvents ? (
        <SettingsBlock title="Life events" last>
          <p>Full wording is on the Mental health tab. These are the events this reflection found:</p>
          <ul className="list-disc pl-5 space-y-1">
            {events.map((event) => (
              <li key={event.id}>
                {event.label}
                {event.date ? ` · ${formatWellnessDay(event.date)}` : ''}
              </li>
            ))}
          </ul>
        </SettingsBlock>
      ) : null}
    </div>
  );
};
