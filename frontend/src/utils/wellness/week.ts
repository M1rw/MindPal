/** "Your week": what the home-screen card says, from the wellness timeline (pure, tested). */
import type { WellnessTimeline } from '../../types/index';

export interface WeekSummary {
  week: string;
  activeDays: number;
  conversations: number;
  mood: 'lighter' | 'heavier' | 'mixed' | null;
  themes: string[];
}

function isoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Monday-based week key, e.g. "2026-09-21". */
export function weekKey(today: Date): string {
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  return isoDay(monday);
}

/** The last seven days of the timeline, or null when there isn't enough to say. */
export function summarizeWeek(timeline: WellnessTimeline | null, today: Date): WeekSummary | null {
  if (!timeline || timeline.empty || timeline.crisis_note) return null;
  const start = new Date(today);
  start.setDate(today.getDate() - 6);
  const from = isoDay(start);
  const days = timeline.activity.filter((point) => point.date >= from && point.turn_count > 0);
  if (days.length < 2) return null;
  const moods = timeline.mood_timeline.filter((point) => point.date >= from);
  const lighter = moods.filter((point) => point.valence === 'lighter').length;
  const heavier = moods.filter((point) => point.valence === 'heavy').length;
  const mood = !moods.length ? null : lighter > heavier * 1.5 ? 'lighter' : heavier > lighter * 1.5 ? 'heavier' : 'mixed';
  const themes = timeline.themes
    .filter((theme) => !theme.last_seen || theme.last_seen >= from)
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 2)
    .map((theme) => theme.label.toLowerCase());
  return {
    week: weekKey(today),
    activeDays: days.length,
    conversations: days.reduce((sum, point) => sum + point.turn_count, 0),
    mood,
    themes,
  };
}
