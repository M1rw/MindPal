import { useAuthStore, useSessionStore } from '../../store/index.ts';
import { isFirebaseConfigured } from '../../services/config.ts';

/**
 * The one answer to "is this person signed in?".
 *
 * There used to be two: the Firebase user (auth store) and whether an ID token
 * was cached (session store). They disagreed whenever a token fetch failed or
 * had not landed yet, so the profile showed a signed-in account while live
 * voice showed the guest gate. A signed-in user is decided by Firebase; the
 * token is transport, and fetchWithAuth refreshes it on a 401.
 *
 * - `loading`     Firebase has not reported yet. Show nothing account-specific.
 * - `unavailable` Sign-in is not configured on this deployment (usually the
 *                 backend could not inject the Firebase config). Don't offer a
 *                 sign-in button that cannot work.
 * - `signed-in` / `guest`
 */
export type AccountStatus = 'loading' | 'unavailable' | 'signed-in' | 'guest';

export function accountStatus(state: {
  firebaseConfigured: boolean;
  isLoading: boolean;
  hasUser: boolean;
  hasToken: boolean;
}): AccountStatus {
  if (!state.firebaseConfigured) return 'unavailable';
  if (state.hasUser) return 'signed-in';
  if (state.hasToken) return 'signed-in';
  if (state.isLoading) return 'loading';
  return 'guest';
}

export function useAccountStatus(): AccountStatus {
  const isLoading = useAuthStore((state) => state.isLoading);
  const hasUser = useAuthStore((state) => Boolean(state.user));
  const hasToken = useSessionStore((state) => state.isAuthenticated);
  return accountStatus({ firebaseConfigured: isFirebaseConfigured(), isLoading, hasUser, hasToken });
}

export function useIsSignedIn(): boolean {
  return useAccountStatus() === 'signed-in';
}
