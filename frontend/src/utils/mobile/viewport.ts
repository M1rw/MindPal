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

export function applyViewportHeight(
  win: Pick<Window, 'innerHeight'> & {
    visualViewport?: { height?: number } | null;
  } = window,
): ViewportMetrics {
  const metrics = getViewportMetrics(win);

  document.documentElement.style.setProperty('--app-height', `${metrics.effectiveHeight}px`);
  document.documentElement.style.setProperty('--keyboard-offset', `${metrics.keyboardOffset}px`);

  return metrics;
}
