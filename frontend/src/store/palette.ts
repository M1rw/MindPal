/**
 * Which actions the search palette shows up front, in the person's order.
 *
 * Stored in the settings store (settings.quickActions), so it is saved on the
 * device and follows the account like every other preference.
 */

import { DEFAULT_QUICK_ACTIONS, MAX_QUICK_ACTIONS, useSettingsStore } from './settings.ts';

export { DEFAULT_QUICK_ACTIONS };
export const MAX_PINNED_ACTIONS = MAX_QUICK_ACTIONS;

const current = (): string[] => useSettingsStore.getState().settings.quickActions;
const save = (quickActions: string[]): void => useSettingsStore.getState().updateSettings({ quickActions });

/** The pinned quick-action ids, re-rendering when they change. */
export function useQuickActions(): string[] {
  return useSettingsStore((state) => state.settings.quickActions);
}

export function togglePinnedAction(id: string): void {
  const ids = current();
  if (ids.includes(id)) save(ids.filter((item) => item !== id));
  else if (ids.length < MAX_QUICK_ACTIONS) save([...ids, id]);
}

export function moveAction(id: string, direction: -1 | 1): void {
  const ids = current();
  const index = ids.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ids.length) return;
  const next = [...ids];
  [next[index], next[target]] = [next[target], next[index]];
  save(next);
}

export function resetQuickActions(): void {
  save([...DEFAULT_QUICK_ACTIONS]);
}
