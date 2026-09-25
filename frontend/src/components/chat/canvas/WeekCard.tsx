/**
 * "Your week" on the home screen: once a week, a short look back built from
 * the wellness timeline (how many days they talked, how the week felt, what
 * came up most), with one tap to reflect on it with MindPal.
 *
 * Only after at least two active days that week, never when the week had a
 * crisis note, once per week, and dismissible.
 */
import React, { useMemo, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useWellnessTimeline } from '../../../hooks/session/useWellnessTimeline';
import { summarizeWeek, weekKey, type WeekSummary } from '../../../utils/wellness/week.ts';

const SEEN_KEY = 'mindpal.week-card.seen';

function readSeen(): string {
  try {
    return window.localStorage.getItem(SEEN_KEY) ?? '';
  } catch {
    return '';
  }
}

function markSeen(week: string): void {
  try {
    window.localStorage.setItem(SEEN_KEY, week);
  } catch {
    // Private mode: it just shows again next time.
  }
}

const MOOD_LINE: Record<NonNullable<WeekSummary['mood']>, string> = {
  lighter: 'It felt lighter more often than not.',
  heavier: 'It was a heavier week.',
  mixed: 'It had its ups and downs.',
};

export const WeekCard: React.FC<{ onReflect?: (text: string) => void }> = ({ onReflect }) => {
  const [seen, setSeen] = useState(readSeen);
  const today = useMemo(() => new Date(), []);
  const alreadySeen = seen === weekKey(today);
  const { data } = useWellnessTimeline(!alreadySeen);
  const summary = useMemo(() => summarizeWeek(data, today), [data, today]);
  if (alreadySeen || !summary) return null;

  const close = () => {
    markSeen(summary.week);
    setSeen(summary.week);
  };
  const talkedAbout = summary.themes.length ? ` Most on your mind: ${summary.themes.join(' and ')}.` : '';

  return (
    <section className="week-card" aria-label="Your week">
      <div className="week-card__head">
        <span className="week-card__title">
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          Your week
        </span>
        <button type="button" className="week-card__close" onClick={close} aria-label="Dismiss your week">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <p className="week-card__text">
        You talked with MindPal on {summary.activeDays} days.
        {summary.mood ? ` ${MOOD_LINE[summary.mood]}` : ''}
        {talkedAbout}
      </p>
      <button
        type="button"
        className="week-card__action"
        onClick={() => {
          close();
          onReflect?.('Can you help me look back on my week?');
        }}
      >
        Reflect on my week
      </button>
    </section>
  );
};
