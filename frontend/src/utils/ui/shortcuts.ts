/** Keyboard shortcut helpers shared by the palette, header hints and the global listener. */

export function isMacLike(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
}

/** "Ctrl K" on Windows/Linux, "⌘K" on Apple devices. `shift` adds ⇧ / Shift. */
export function shortcutLabel(key: string, { shift = false }: { shift?: boolean } = {}): string {
  if (isMacLike()) return `${shift ? '⇧' : ''}⌘${key}`;
  return `Ctrl ${shift ? 'Shift ' : ''}${key}`;
}

/** Ctrl on Windows/Linux, Cmd on Apple devices, plus the given key. */
export function matchesShortcut(event: KeyboardEvent, key: string, { shift = false }: { shift?: boolean } = {}): boolean {
  const primary = isMacLike() ? event.metaKey : event.ctrlKey;
  return primary && !event.altKey && event.shiftKey === shift && event.key.toLowerCase() === key.toLowerCase();
}
