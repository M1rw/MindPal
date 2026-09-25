/**
 * "Your week" on the home screen: once a week, a short look back built from
 * the wellness timeline (how many days they talked, how the week felt, what
 * came up most), with one tap to reflect on it with MindPal.
 *
 * Only after at least two active days that week, never when the week had a
 * crisis note, once per week, and dismissible.
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarHeart, Sparkles } from 'lucide-react';
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

const OPENED_KEY = 'mindpal.week-card.opened';

function readKey(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeKey(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode: it simply behaves as new next time.
  }
}

/**
 * "Your week" as an icon in the header, beside the other actions, with an
 * unread dot. The first time it appears in a week its tooltip opens by itself
 * under the icon; after that it opens on tap. Outside taps and Escape close
 * it; "Hide for this week" removes the icon until next week.
 */
export const WeekButton: React.FC<{ className: string; onReflect?: (text: string) => void }> = ({ className, onReflect }) => {
  const [seen, setSeen] = useState(readSeen);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(true);
  const [leaving, setLeaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number; arrow: number } | null>(null);
  const today = useMemo(() => new Date(), []);
  const week = weekKey(today);
  const alreadySeen = seen === week;
  const { data } = useWellnessTimeline(!alreadySeen);
  const summary = useMemo(() => summarizeWeek(data, today), [data, today]);

  // First sight this week: show the tooltip without being asked, once.
  useEffect(() => {
    if (!summary || alreadySeen) return undefined;
    if (readKey(OPENED_KEY) === week) {
      setUnread(false);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setOpen(true);
      setUnread(false);
      writeKey(OPENED_KEY, week);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [summary, alreadySeen, week]);

  // Under the icon, kept 16px inside the screen, the arrow pointing at the icon.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const position = () => {
      const button = buttonRef.current?.getBoundingClientRect();
      if (!button) return;
      const width = Math.min(320, window.innerWidth - 32);
      const center = button.left + button.width / 2;
      const left = Math.max(16, Math.min(window.innerWidth - 16 - width, center - width / 2));
      setPlace({ top: button.bottom + 10, left, arrow: center - left });
    };
    position();
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || document.getElementById('week-tip')?.contains(target)) return;
      setOpen(false);
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
    <div ref={rootRef} className={cn('week-anchor', leaving && 'is-leaving')}>
      <button
        ref={buttonRef}
        type="button"
        className={cn(className, 'week-btn', open && 'is-open')}
        title="Your week"
        aria-label="Your week"
        aria-expanded={open}
        aria-controls="week-tip"
        onClick={() => {
          setOpen(!open);
          setUnread(false);
          writeKey(OPENED_KEY, week);
        }}
      >
        <CalendarHeart className="h-4 w-4" aria-hidden="true" />
        {unread ? <span className="week-btn__dot" aria-hidden="true" /> : null}
      </button>
      {/* At the page root: an animated or blurred ancestor would otherwise
          become its positioning box and move it away from the icon. */}
      {createPortal(
      <div
        id="week-tip"
        role="dialog"
        aria-label="Your week"
        className={cn('week-tip', open && place && 'is-open')}
        style={place ? ({ top: place.top, left: place.left, '--arrow-x': `${place.arrow}px` } as React.CSSProperties) : undefined}
        inert={open ? undefined : true}
      >
        <p className="week-tip__title">
          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          Your week
        </p>
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
      </div>,
        document.body,
      )}
    </div>
  );
};
