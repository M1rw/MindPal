import { useEffect } from 'react';
import { useAuthStore, useSessionStore, useChatHistoryStore } from '../store/index';
import { onAuthStateChange, getIdToken, getAppCheckToken } from '../services/auth/index';

export function useAuthBootstrap() {
  const { setUser, setIsLoading } = useAuthStore();
  const { setAuth } = useSessionStore();

  useEffect(() => {
    const unsubscribe = onAuthStateChange(async (user) => {
      setUser(user);
      setIsLoading(false);

      if (user) {
        const idToken = await getIdToken();
        const appCheckToken = await getAppCheckToken();
        setAuth(user.uid, idToken, appCheckToken);
        useChatHistoryStore.getState().loadCloudSessions();
      } else {
        setAuth(null, null, null);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [setAuth, setIsLoading, setUser]);
}
