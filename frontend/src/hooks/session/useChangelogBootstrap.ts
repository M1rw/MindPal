import { useEffect } from 'react';
import { useAuthStore, useChangelogStore, useSessionStore } from '../../store/index';
import { STORAGE_KEYS } from '../../constants/storage';
import { ApiClient } from '../../services/api/index';

export function useChangelogBootstrap() {
  const authUser = useAuthStore((state) => state.user);
  const authLoading = useAuthStore((state) => state.isLoading);
  const isAuthenticated = useSessionStore((state) => state.isAuthenticated);

  useEffect(() => {
    if (authLoading) return;
    if (authUser && !isAuthenticated) return;

    const checkChangelog = async () => {
      try {
        const data = await ApiClient.getChangelog();
        if (!data) return;

        const currentVer = data.current_version || '5.0.0';
        const lastSeen = authUser || isAuthenticated
          ? null
          : localStorage.getItem(STORAGE_KEYS.LAST_SEEN_CHANGELOG);
        const dismissedForAccount = data.dismissed_versions?.includes(currentVer) ?? false;
        const hasMajor = data.entries?.some((entry) => entry.version === currentVer && entry.major);

        if (hasMajor && !dismissedForAccount && lastSeen !== currentVer) {
          useChangelogStore.getState().setChangelog(data);
          useChangelogStore.getState().setIsOpen(true);
        }
      } catch (err) {
        console.warn('Changelog check on mount:', err);
      }
    };

    checkChangelog();
  }, [authLoading, authUser, isAuthenticated]);
}
