import { useEffect } from 'react';
import { useAuthStore, useSessionStore, useChatHistoryStore, useStreakStore, useUsageStore } from '../../store/index';
import {
  onAuthStateChange,
  onIdTokenChange,
  getIdToken,
  getAppCheckToken,
} from '../../services/auth/index';
import { ApiClient } from '../../services/api/index';
import { pullAccountSettings, resetSettingsSync, subscribeSettingsSync } from '../../services/sync/settingsSync.ts';

export function useAuthBootstrap() {
  const { setUser, setIsLoading } = useAuthStore();
  const { setAuth } = useSessionStore();

  useEffect(() => {
    const unsubscribe = onAuthStateChange(async (user) => {
      // A guest's per-network credits are not the account's, and vice versa.
      useUsageStore.getState().clearQuota();
      if (user) {
        // One forced retry: a null token here left a signed-in user looking
        // like a guest to every request until the hourly refresh.
        const idToken = (await getIdToken()) ?? (await getIdToken({ forceRefresh: true }));
        const appCheckToken = await getAppCheckToken();
        setAuth(user.uid, idToken, appCheckToken);
        setUser(user);
        setIsLoading(false);
        void ApiClient.mergeGuestGraphIntoAccount().catch(() => {
          // Device facts stay local until the next signed-in memory load.
        });
        void pullAccountSettings().catch(() => {
          // Device settings stay in effect; the next change pushes them.
        });
        useChatHistoryStore.getState().loadCloudSessions();
        void useStreakStore.getState().refreshFromAccount();
        return;
      }

      setUser(null);
      setAuth(null, null, null);
      resetSettingsSync();
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

    const unsubscribeSettings = subscribeSettingsSync();

    return () => {
      unsubscribe();
      unsubscribeToken();
      unsubscribeSettings();
    };
  }, [setAuth, setIsLoading, setUser]);
}
