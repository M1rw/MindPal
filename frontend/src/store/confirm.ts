/**
 * One confirmation dialog for the whole app.
 *
 *   if (await confirmAction({ title: 'Delete this chat?', tone: 'danger', confirmLabel: 'Delete' })) { ... }
 *
 * Replaces window.confirm (blocked and always false in iOS PWAs and in-app
 * browsers) and the one-off inline banners each feature grew. Requests queue,
 * so two features asking at once are answered one after the other.
 *
 * `dontAskAgainKey` adds a "Don't ask again" checkbox; once ticked and
 * confirmed, later requests with the same key resolve true without showing.
 * The choice is a setting (settings.skipConfirm): it follows the account and
 * can be turned back on in Settings > General.
 */

import { create } from 'zustand';
import { CONFIRM_KEYS, useSettingsStore } from './settings.ts';

export type ConfirmKey = (typeof CONFIRM_KEYS)[number];
import type { ComponentType, SVGProps } from 'react';

export type ConfirmTone = 'default' | 'danger';

export interface ConfirmOptions {
  title: string;
  /** One or two short sentences. Plain text. */
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
  /** A lucide icon (or any SVG component) shown beside the title. */
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  /** Offer "Don't ask again", remembered as a setting under this key. */
  dontAskAgainKey?: ConfirmKey;
}

interface ConfirmRequest extends ConfirmOptions {
  id: number;
  resolve: (confirmed: boolean) => void;
}

interface ConfirmState {
  queue: ConfirmRequest[];
  push: (request: ConfirmRequest) => void;
  settle: (id: number, confirmed: boolean, remember?: boolean) => void;
}

let nextId = 1;

function skipped(key: ConfirmKey | undefined): boolean {
  return Boolean(key && useSettingsStore.getState().settings.skipConfirm[key]);
}

/** Turn a "Don't ask again" on or off (Settings shows it as "Ask before ..."). */
export function setConfirmSkipped(key: ConfirmKey, skip: boolean): void {
  useSettingsStore.getState().updateSettings({ skipConfirm: { [key]: skip } });
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  queue: [],
  push: (request) => set((state) => ({ queue: [...state.queue, request] })),
  settle: (id, confirmed, remember = false) => {
    const request = get().queue.find((item) => item.id === id);
    if (!request) return;
    if (confirmed && remember && request.dontAskAgainKey) setConfirmSkipped(request.dontAskAgainKey, true);
    set((state) => ({ queue: state.queue.filter((item) => item.id !== id) }));
    request.resolve(confirmed);
  },
}));

/** Ask the person; resolves true on confirm, false on cancel, Esc or backdrop. */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  if (skipped(options.dontAskAgainKey)) return Promise.resolve(true);
  return new Promise((resolve) => {
    useConfirmStore.getState().push({ ...options, id: nextId++, resolve });
  });
}

/** Forget every "Don't ask again" (e.g. from a settings reset). */
export function resetConfirmPreferences(): void {
  const skipConfirm = Object.fromEntries(CONFIRM_KEYS.map((key) => [key, false]));
  useSettingsStore.getState().updateSettings({ skipConfirm });
}
