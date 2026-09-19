import { useEffect } from 'react';
import { useAuthStore, useSessionStore, useChatHistoryStore, useStreakStore } from '../../store/index';
import {
  onAuthStateChange,
  onIdTokenChange,
  getIdToken,
  getAppCheckToken,
} from '../../services/auth/index';
import { ApiClient } from '../../services/api/index';

export function useAuthBootstrap() {
  const { setUser, setIsLoading } = useAuthStore();
  const { setAuth } = useSessionStore();

  useEffect(() => {
    const unsubscribe = onAuthStateChange(async (user) => {
      if (user) {
        const idToken = await getIdToken();
        const appCheckToken = await getAppCheckToken();
        setAuth(user.uid, idToken, appCheckToken);
        setUser(user);
        setIsLoading(false);
        void ApiClient.mergeGuestGraphIntoAccount().catch(() => {
          // Device facts stay local until the next signed-in memory load.
        });
        useChatHistoryStore.getState().loadCloudSessions();
        void useStreakStore.getState().refreshFromAccount();
        return;
      }

      setUser(null);
      setAuth(null, null, null);
      setIsLoading(false);
      useStreakStore.getState().restoreDeviceStreak();
    });

    // Firebase refreshes the ID token roughly hourly, and onAuthStateChange does
    // NOT fire for that. Without this the store keeps the token it was given at
    // sign-in, and every authenticated request 401s once it expires - which is
    // how a long live call ended up with the control plane refusing every event.
    const unsubscribeToken = onIdTokenChange((user, idToken) => {
      if (!user || !idToken) return;
      const { appCheckToken } = useSessionStore.getState();
      setAuth(user.uid, idToken, appCheckToken);
    });

    return () => {
      unsubscribe();
      unsubscribeToken();
    };
  }, [setAuth, setIsLoading, setUser]);
}
