import { useEffect } from 'react';
import { useAuthStore, useChangelogStore, useSessionStore } from '../../store/index';
import { STORAGE_KEYS } from '../../constants/storage';
import { ApiClient } from '../../services/api/index';

let changelogRequestId = 0;

export function useChangelogBootstrap() {
  const authUser = useAuthStore((state) => state.user);
  const authLoading = useAuthStore((state) => state.isLoading);
  const isAuthenticated = useSessionStore((state) => state.isAuthenticated);

  useEffect(() => {
    if (authLoading) return;
    if (authUser && !isAuthenticated) return;

    const checkChangelog = async () => {
      const requestId = ++changelogRequestId;
      try {
        const data = await ApiClient.getChangelog();
        if (!data) return;

        if (requestId !== changelogRequestId) return;

        const currentVer = data.current_version || '5.0.5';
        const lastSeen = authUser || isAuthenticated
          ? null
          : localStorage.getItem(STORAGE_KEYS.LAST_SEEN_CHANGELOG);
        // A first visit has nothing to be "new" against: note the version
        // quietly so only returning guests see the next announcement.
        if (!authUser && !isAuthenticated && lastSeen === null) {
          try {
            localStorage.setItem(STORAGE_KEYS.LAST_SEEN_CHANGELOG, currentVer);
          } catch {
            // Private mode: nothing to remember it by, so nothing to show.
          }
          return;
        }
        const dismissedForAccount = data.dismissed_versions?.includes(currentVer) ?? false;
        const hasMajor = data.entries?.some((entry) => entry.version === currentVer && (entry.major || entry.announce));

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
