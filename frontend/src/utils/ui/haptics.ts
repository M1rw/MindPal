export type HapticPattern = 'selection' | 'success' | 'warning' | 'error' | 'thinking';

const PATTERNS: Record<HapticPattern, number | number[]> = {
  selection: 8,
  success: [10, 24, 10],
  warning: [18, 32, 18],
  error: [24, 36, 24],
  thinking: [5, 70, 5],
};

let lastPulseAt = 0;

function canVibrate(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

export function triggerHaptic(enabled: boolean, pattern: HapticPattern = 'selection'): boolean {
  if (!enabled || !canVibrate()) return false;

  const now = Date.now();
  if (now - lastPulseAt < 40) return false;

  try {
    const didVibrate = navigator.vibrate(PATTERNS[pattern]);
    if (didVibrate) lastPulseAt = now;
    return didVibrate;
  } catch {
    return false;
  }
}

export function stopHaptic(): void {
  if (!canVibrate()) return;
  try {
    navigator.vibrate(0);
  } catch {
    // Vibration is optional and can be blocked by the browser or device.
  }
}