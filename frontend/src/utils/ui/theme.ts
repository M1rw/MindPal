/**
 * Theme: settings.theme is the one source of truth ('light' | 'dark' | 'system').
 *
 * Every control (header toggle, palette, Settings) writes the setting; the
 * binding below applies it to <html>, so a theme pulled from the account on
 * another device lands too. `mindpal_theme` mirrors the applied value only so
 * main.tsx can paint the right colours before React and the store load.
 */

import { STORAGE_KEYS } from '../../constants/storage.ts';
import { useSettingsStore } from '../../store/settings.ts';
import type { UserUISettings } from '../../types/index';

type Theme = UserUISettings['theme'];

/** Fired on window after the applied theme changes, so every toggle stays in sync. */
export const THEME_EVENT = 'mindpal:theme';

const systemDark = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : true;

export function resolvesDark(theme: Theme): boolean {
  return theme === 'system' ? systemDark() : theme !== 'light';
}

export function isDarkTheme(): boolean {
  return typeof document === 'undefined' ? true : document.documentElement.classList.contains('dark');
}

function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const dark = resolvesDark(theme);
  const root = document.documentElement;
  const changed = root.classList.contains('dark') !== dark || !root.classList.contains(dark ? 'dark' : 'light');
  root.classList.toggle('dark', dark);
  root.classList.toggle('light', !dark);
  try {
    localStorage.setItem(STORAGE_KEYS.THEME, dark ? 'dark' : 'light');
  } catch {
    // Storage blocked: the theme still applies for this visit.
  }
  if (changed) window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { dark } }));
}

export function setTheme(theme: Theme): void {
  useSettingsStore.getState().updateSettings({ theme });
  applyTheme(theme); // also applied by the binding; immediate for callers that read isDarkTheme()
}

export function setDarkTheme(dark: boolean): void {
  setTheme(dark ? 'dark' : 'light');
}

export function toggleTheme(): boolean {
  const next = !isDarkTheme();
  setDarkTheme(next);
  return next;
}

/** Apply the saved theme and keep applying it as the setting or the OS changes. Call once at boot. */
export function bindThemeToSettings(): () => void {
  // Before the setting was authoritative, the header toggle wrote only the
  // mirror key, so it can hold a newer choice than the setting. Adopt it; after
  // this every write goes through the setting and the two cannot disagree.
  const settings = useSettingsStore.getState().settings;
  try {
    const applied = localStorage.getItem(STORAGE_KEYS.THEME);
    if ((applied === 'light' || applied === 'dark') && settings.theme !== 'system' && applied !== settings.theme) {
      useSettingsStore.getState().updateSettings({ theme: applied });
    }
  } catch {
    // Storage blocked: the setting stands.
  }
  applyTheme(useSettingsStore.getState().settings.theme);
  const unsubscribe = useSettingsStore.subscribe((state, previous) => {
    if (state.settings.theme !== previous.settings.theme) applyTheme(state.settings.theme);
  });
  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const onSystemChange = () => {
    if (useSettingsStore.getState().settings.theme === 'system') applyTheme('system');
  };
  media?.addEventListener?.('change', onSystemChange);
  // On phones the OS theme is usually switched while the app is in the
  // background (Control Centre, a sunset schedule); re-check on return rather
  // than relying on the media event alone.
  const onVisible = () => {
    if (document.visibilityState === 'visible') onSystemChange();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    unsubscribe();
    media?.removeEventListener?.('change', onSystemChange);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
