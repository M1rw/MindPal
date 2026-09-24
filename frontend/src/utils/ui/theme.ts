import { STORAGE_KEYS } from '../../constants/storage.ts';

/** Fired on window after the theme changes, so every toggle stays in sync. */
export const THEME_EVENT = 'mindpal:theme';

export function isDarkTheme(): boolean {
  return typeof document === 'undefined' ? true : document.documentElement.classList.contains('dark');
}

export function setDarkTheme(dark: boolean): void {
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.classList.toggle('light', !dark);
  try {
    localStorage.setItem(STORAGE_KEYS.THEME, dark ? 'dark' : 'light');
  } catch {
    // Storage blocked: the theme still applies for this visit.
  }
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { dark } }));
}

export function toggleTheme(): boolean {
  const next = !isDarkTheme();
  setDarkTheme(next);
  return next;
}
