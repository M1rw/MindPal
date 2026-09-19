const EMPTY_WEEK = [false, false, false, false, false, false, false] as const;

export const WEEKDAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const;

export const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function utcYesterday(fromIso = utcToday()): string {
  const date = new Date(`${fromIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function mondayOf(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

export function mondayIndex(isoDate = utcToday()): number {
  return (new Date(`${isoDate}T00:00:00Z`).getUTCDay() + 6) % 7;
}

export function emptyWeek(): boolean[] {
  return [...EMPTY_WEEK];
}

export function weekDaysFor(weeklyDays: boolean[] | undefined, lastActiveDate: string | null): boolean[] {
  const week = Array.isArray(weeklyDays) && weeklyDays.length === 7 ? weeklyDays.map(Boolean) : emptyWeek();
  if (!lastActiveDate) return emptyWeek();
  if (mondayOf(lastActiveDate) !== mondayOf(utcToday())) return emptyWeek();
  return week;
}

export function streakHeadline(count: number): string {
  if (count === 1) return '1 day in a row';
  return `${count} days in a row`;
}

export function streakSupport(count: number, todayDone: boolean, weekHasAny: boolean): string {
  if (todayDone) return "That's enough for today.";
  if (count > 0) return 'One message today keeps this going.';
  if (weekHasAny) {
    return 'Consecutive days start again with a message today. This week still shows when you wrote.';
  }
  return 'One message is enough.';
}

export function streakSourceNote(source: 'device' | 'account'): string {
  return source === 'account'
    ? 'Counted from days you sent a message on this account.'
    : 'Counted on this device until you sign in.';
}

export function dayAriaLabel(index: number, done: boolean, isToday: boolean): string {
  const name = WEEKDAY_NAMES[index];
  const today = isToday ? ', today' : '';
  const state = done ? 'wrote' : 'no message';
  return `${name}${today}: ${state}`;
}
