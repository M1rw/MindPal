/**
 * Keep the screen on while something needs it (a live voice call).
 *
 * Phones dim and lock after ~30s without a touch, which ended calls mid-sentence.
 * The Screen Wake Lock API (iOS 16.4+, Android Chrome) holds the screen on; the
 * browser drops the lock whenever the page is hidden, so it is taken again when
 * the page comes back. Where the API is missing this is a quiet no-op.
 */

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
}

interface WakeLockNavigator {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
}

/** Holds the screen awake until the returned function is called. */
export function holdScreenAwake(): () => void {
  if (typeof navigator === 'undefined' || typeof document === 'undefined') return () => {};
  const api = (navigator as Navigator & WakeLockNavigator).wakeLock;
  if (!api) return () => {};

  let sentinel: WakeLockSentinelLike | null = null;
  let active = true;

  const acquire = () => {
    if (!active || document.visibilityState !== 'visible' || (sentinel && !sentinel.released)) return;
    api
      .request('screen')
      .then((lock) => {
        if (active) sentinel = lock;
        else void lock.release().catch(() => {});
      })
      .catch(() => {
        // Denied (low battery, permissions policy): the call goes on regardless.
      });
  };
  const onVisibility = () => acquire();

  acquire();
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    active = false;
    document.removeEventListener('visibilitychange', onVisibility);
    void sentinel?.release().catch(() => {});
    sentinel = null;
  };
}
