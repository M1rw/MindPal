import { useLayoutEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'button:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable]',
  '[tabindex]:not([tabindex^="-"])',
].join(', ');

export interface UseFocusTrapOptions {
  isOpen: boolean;
  onClose?: () => void;
  autoFocus?: boolean;
  restoreFocus?: boolean;
  paused?: boolean;
}

/**
 * WCAG 2.1 AA Compliant Keyboard Focus Trap
 * Traps Tab and Shift+Tab within active modal container, restores focus on close, and closes on Escape.
 * Auto-focus and restore run only when `isOpen` changes, so in-overlay edits keep focus.
 * `paused` keeps the trap mounted (no restore/refocus) while a higher overlay owns keyboard.
 */
export function useFocusTrap<T extends HTMLElement = HTMLDivElement>({
  isOpen,
  onClose,
  autoFocus = true,
  restoreFocus = true,
  paused = false,
}: UseFocusTrapOptions) {
  const containerRef = useRef<T>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const autoFocusRef = useRef(autoFocus);
  const restoreFocusRef = useRef(restoreFocus);
  const pausedRef = useRef(paused);
  const focusFrameRef = useRef<number | null>(null);
  onCloseRef.current = onClose;
  autoFocusRef.current = autoFocus;
  restoreFocusRef.current = restoreFocus;
  pausedRef.current = paused;

  useLayoutEffect(() => {
    if (!isOpen) return;

    previousActiveElementRef.current = document.activeElement as HTMLElement | null;

    const container = containerRef.current;
    if (!container) return;

    if (autoFocusRef.current) {
      focusFrameRef.current = requestAnimationFrame(() => {
        // An element marked data-autofocus wins; otherwise the first focusable.
        const preferred = container.querySelector<HTMLElement>('[data-autofocus]');
        (preferred ?? container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR))?.focus({ preventScroll: true });
      });
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (pausedRef.current) return;

      const target = e.target as HTMLElement | null;
      const inFloatingMenu = Boolean(target?.closest('[data-overlay-escape="ignore"]'));

      if (e.key === 'Escape') {
        if (inFloatingMenu) return;
        e.stopPropagation();
        onCloseRef.current?.();
        return;
      }

      if (e.key !== 'Tab') return;
      if (inFloatingMenu) return;

      const focusableElements = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((el) => el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0);

      if (focusableElements.length === 0) {
        e.preventDefault();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === firstElement || !container.contains(document.activeElement)) {
          e.preventDefault();
          lastElement.focus();
        }
      } else {
        if (document.activeElement === lastElement || !container.contains(document.activeElement)) {
          e.preventDefault();
          firstElement.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      if (focusFrameRef.current !== null) {
        cancelAnimationFrame(focusFrameRef.current);
        focusFrameRef.current = null;
      }
      if (!pausedRef.current && restoreFocusRef.current && previousActiveElementRef.current?.isConnected) {
        previousActiveElementRef.current.focus({ preventScroll: true });
      }
    };
  }, [isOpen]);

  return containerRef;
}
