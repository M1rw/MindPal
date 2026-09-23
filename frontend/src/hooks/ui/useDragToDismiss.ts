/**
 * useDragToDismiss — bottom-sheet swipe-to-close hook.
 *
 * Attach panelRef to the modal panel element and call onClose when the user
 * swipes down past the dismiss threshold.
 *
 * - Only active on `pointer: coarse` (touch) devices.
 * - Drag must start within the top 48px "drag handle zone" of the panel.
 * - Dismiss threshold: panel displaced > 25% of its own height OR release
 *   velocity > 400px/s downward.
 * - On non-dismiss: panel springs back with a CSS transition.
 */

import { useEffect, useRef } from 'react';

const HANDLE_ZONE_PX = 48;
const DISMISS_RATIO = 0.25;
const DISMISS_VELOCITY_PX_S = 400;

export function useDragToDismiss(
  panelRef: React.RefObject<HTMLElement | null>,
  onClose: () => void,
  enabled = true,
) {
  const startYRef = useRef(0);
  const startTimeRef = useRef(0);
  const currentYRef = useRef(0);
  const draggingRef = useRef(false);
  const dismissTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!window.matchMedia('(pointer: coarse)').matches) return;

    const el = panelRef.current;
    if (!el) return;

    function applyTranslate(dy: number) {
      if (!panelRef.current) return;
      const clamped = Math.max(0, dy);
      panelRef.current.style.transition = 'none';
      panelRef.current.style.transform = `translate3d(0, ${clamped}px, 0)`;
    }

    function springBack() {
      const panel = panelRef.current;
      if (!panel) return;
      panel.style.transition = 'transform 320ms cubic-bezier(0.22, 1, 0.36, 1)';
      panel.style.transform = 'translate3d(0, 0, 0)';
    }

    function dismiss() {
      const panel = panelRef.current;
      if (!panel) return;
      const h = panel.getBoundingClientRect().height;
      panel.style.transition = 'transform 260ms ease-in';
      panel.style.transform = `translate3d(0, ${h + 60}px, 0)`;
      dismissTimerRef.current = window.setTimeout(() => {
        if (panelRef.current) {
          panelRef.current.style.transition = '';
          panelRef.current.style.transform = '';
        }
        dismissTimerRef.current = null;
        onClose();
      }, 270);
    }

    function onTouchStart(e: TouchEvent) {
      const panel = panelRef.current;
      if (!panel) return;
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      const panelTop = panel.getBoundingClientRect().top;
      if (touch.clientY - panelTop > HANDLE_ZONE_PX) return;
      startYRef.current = touch.clientY;
      currentYRef.current = touch.clientY;
      startTimeRef.current = performance.now();
      draggingRef.current = true;
    }

    function onTouchMove(e: TouchEvent) {
      if (!draggingRef.current) return;
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      currentYRef.current = touch.clientY;
      const dy = touch.clientY - startYRef.current;
      if (dy > 4) e.preventDefault();
      applyTranslate(dy);
    }

    function onTouchEnd() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      const panel = panelRef.current;
      if (!panel) return;
      const dy = currentYRef.current - startYRef.current;
      const dt = (performance.now() - startTimeRef.current) / 1000;
      const velocity = dt > 0 ? dy / dt : 0;
      const panelH = panel.getBoundingClientRect().height;
      if (dy > panelH * DISMISS_RATIO || velocity > DISMISS_VELOCITY_PX_S) {
        dismiss();
      } else {
        springBack();
      }
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      if (dismissTimerRef.current !== null) {
        window.clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      el.style.transition = '';
      el.style.transform = '';
    };
  }, [enabled, onClose, panelRef]);
}
