/**
 * "Your week" on the home screen: once a week, a short look back built from
 * the wellness timeline (how many days they talked, how the week felt, what
 * came up most), with one tap to reflect on it with MindPal.
 *
 * Only after at least two active days that week, never when the week had a
 * crisis note, once per week, and dismissible.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { cn } from '../../../utils/ui/cn';
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

/**
 * A small notification pill above the greeting ("Your week", with a soft dot).
 * Tapping it opens a tooltip with the look back and one action; outside taps
 * and Escape close it, and "Hide for this week" puts it away until next week.
 */
export const WeekCard: React.FC<{ onReflect?: (text: string) => void }> = ({ onReflect }) => {
  const [seen, setSeen] = useState(readSeen);
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const today = useMemo(() => new Date(), []);
  const alreadySeen = seen === weekKey(today);
  const { data } = useWellnessTimeline(!alreadySeen);
  const summary = useMemo(() => summarizeWeek(data, today), [data, today]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (alreadySeen || !summary) return null;

  const hide = () => {
    setOpen(false);
    setLeaving(true);
    window.setTimeout(() => {
      markSeen(summary.week);
      setSeen(summary.week);
    }, 220);
  };
  const talkedAbout = summary.themes.length ? ` Most on your mind: ${summary.themes.join(' and ')}.` : '';

  return (
    <div ref={rootRef} className={cn('week-pill-wrap', leaving && 'is-leaving')}>
      <button
        type="button"
        className={cn('week-pill', open && 'is-open')}
        aria-expanded={open}
        aria-controls="week-tip"
        onClick={() => setOpen(!open)}
      >
        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
        Your week
        <span className="week-pill__dot" aria-hidden="true" />
      </button>
      <div id="week-tip" role="dialog" aria-label="Your week" className={cn('week-tip', open && 'is-open')} inert={open ? undefined : true}>
        <p className="week-tip__text">
          You talked with MindPal on {summary.activeDays} days.
          {summary.mood ? ` ${MOOD_LINE[summary.mood]}` : ''}
          {talkedAbout}
        </p>
        <div className="week-tip__actions">
          <button
            type="button"
            className="week-tip__primary"
            onClick={() => {
              hide();
              onReflect?.('Can you help me look back on my week?');
            }}
          >
            Reflect on my week
          </button>
          <button type="button" className="week-tip__quiet" onClick={hide}>
            Hide for this week
          </button>
        </div>
      </div>
    </div>
  );
};
