import { useEffect, useState } from 'react';

/** Keep in sync with overlay exit keyframes in style.css. */
export const OVERLAY_EXIT_MS = 100;

/** Keep in sync with popover/menu exit keyframes in style.css. */
export const POPOVER_EXIT_MS = 90;

/**
 * Stay mounted through the exit animation so overlays can ease out.
 * `visible` follows `isOpen` in the same render as the click so motion
 * starts on the first painted frame (no useEffect delay).
 */
export function useOverlayPresence(isOpen: boolean, exitMs: number = OVERLAY_EXIT_MS) {
  const [mounted, setMounted] = useState(isOpen);

  if (isOpen && !mounted) {
    setMounted(true);
  }

  useEffect(() => {
    if (isOpen) return undefined;
    const timeoutId = window.setTimeout(() => setMounted(false), exitMs);
    return () => window.clearTimeout(timeoutId);
  }, [isOpen, exitMs]);

  return { mounted, visible: isOpen };
}
