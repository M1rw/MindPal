export interface ViewportMetrics {
  innerHeight: number;
  visualHeight: number;
  keyboardOffset: number;
  effectiveHeight: number;
}

export function getViewportMetrics(
  win: Pick<Window, 'innerHeight'> & {
    visualViewport?: { height?: number } | null;
  } = window,
): ViewportMetrics {
  const innerHeight = Number.isFinite(win.innerHeight) ? win.innerHeight : 0;
  const resolvedVisualHeight =
    win.visualViewport && Number.isFinite(win.visualViewport.height)
      ? win.visualViewport.height
      : innerHeight;
  const visualHeightNumber = Number.isFinite(resolvedVisualHeight)
    ? Number(resolvedVisualHeight)
    : innerHeight;
  const keyboardOffset = Math.max(0, innerHeight - visualHeightNumber);
  const effectiveHeight = Math.max(0, visualHeightNumber);

  return {
    innerHeight,
    visualHeight: visualHeightNumber,
    keyboardOffset,
    effectiveHeight,
  };
}

/**
 * Returns true when the currently focused element lives inside a modal dialog
 * (role="dialog") or any element marked with data-modal-input="true".
 * In this case the keyboard offset should NOT be applied to the chat composer
 * so it doesn't jump up when the user types in a history search box, settings
 * input, etc.
 */
function focusIsInsideModal(): boolean {
  try {
    const active = document.activeElement;
    if (!active || active === document.body) return false;
    return Boolean(active.closest('[role="dialog"]'));
  } catch {
    return false;
  }
}

export function applyViewportHeight(
  win: Pick<Window, 'innerHeight'> & {
    visualViewport?: { height?: number; offsetTop?: number } | null;
  } = window,
): ViewportMetrics {
  const metrics = getViewportMetrics(win);

  document.documentElement.style.setProperty('--app-height', `${metrics.effectiveHeight}px`);
  const offsetTop = Number(win.visualViewport?.offsetTop);
  document.documentElement.style.setProperty('--vv-top', `${Number.isFinite(offsetTop) ? Math.max(0, offsetTop) : 0}px`);

  // Only lift the composer dock when the keyboard was opened by an input
  // that lives INSIDE the chat composer, not inside a modal dialog.
  // This prevents the chatbox from jumping when the user types in the
  // history search box, rename input, or any settings input field.
  const suppressOffset = focusIsInsideModal();
  document.documentElement.style.setProperty(
    '--keyboard-offset',
    suppressOffset ? '0px' : `${metrics.keyboardOffset}px`,
  );

  return metrics;
}
