// frontend/js/utils/dates.js — Date & streak calculation helpers

/**
 * Get a YYYY-MM-DD key for a date (defaults to now, local timezone).
 */
export function getLocalDateKey(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);

  if (Number.isNaN(value.getTime())) {
    return "";
  }

  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

/**
 * Parse a YYYY-MM-DD string into a Date (local timezone).
 */
export function parseLocalDateKey(dateKey) {
  const [year, month, day] = String(dateKey || "").split("-").map(Number);

  if (!year || !month || !day) {
    return new Date();
  }

  return new Date(year, month - 1, day);
}

/**
 * Add/subtract days from a date key, returning a new date key.
 */
export function addDaysLocal(dateKey, deltaDays) {
  const date = parseLocalDateKey(dateKey);
  date.setDate(date.getDate() + Number(deltaDays || 0));
  return getLocalDateKey(date);
}

/**
 * Normalize a date value (ISO string, date key, etc.) into a YYYY-MM-DD key.
 */
export function normalizeDateKey(value) {
  const raw = String(value || "").trim();

  if (!raw) return "";

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  const parsed = new Date(raw);

  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return getLocalDateKey(parsed);
}

/**
 * Deduplicate & sort an array of date keys.
 */
export function normalizeDayKeys(values) {
  if (!Array.isArray(values)) return [];

  const seen = new Set();
  const output = [];

  for (const value of values) {
    const key = normalizeDateKey(value);

    if (!key || seen.has(key)) continue;

    seen.add(key);
    output.push(key);
  }

  output.sort();
  return output;
}

/**
 * Count the current consecutive-day streak ending at todayKey.
 */
export function computeCurrentStreak(activeDays, todayKey = getLocalDateKey()) {
  let cursor = todayKey;
  let count = 0;

  while (activeDays.has(cursor)) {
    count += 1;
    cursor = addDaysLocal(cursor, -1);
  }

  return count;
}

/**
 * Get the most recent date from a Set of date keys.
 */
export function getMostRecentActiveDate(activeDays) {
  const values = Array.from(activeDays || []).filter(Boolean).sort();
  return values.length ? values[values.length - 1] : null;
}

/**
 * Get the last 7 day keys + labels ending at todayKey.
 */
export function getLast7Days(todayKey = getLocalDateKey()) {
  const labels = ["S", "M", "T", "W", "T", "F", "S"];
  const output = [];

  for (let offset = 6; offset >= 0; offset -= 1) {
    const key = addDaysLocal(todayKey, -offset);
    const date = parseLocalDateKey(key);

    output.push({
      key,
      label: labels[date.getDay()],
    });
  }

  return output;
}
