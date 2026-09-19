import { useEffect } from 'react';
import { useChangelogStore } from '../../store/index';
import { STORAGE_KEYS } from '../../constants/storage';
import { ApiClient } from '../../services/api/index';

export function useChangelogBootstrap() {
  useEffect(() => {
    const checkChangelog = async () => {
      try {
        const data = await ApiClient.getChangelog();
        if (!data) return;

        const currentVer = data.current_version || '5.0.0';
        const lastSeen = localStorage.getItem(STORAGE_KEYS.LAST_SEEN_CHANGELOG);
        const hasMajor = data.entries?.some((entry) => entry.version === currentVer && entry.major);

        if (hasMajor && lastSeen !== currentVer) {
          useChangelogStore.getState().setChangelog(data);
          useChangelogStore.getState().setIsOpen(true);
        }
      } catch (err) {
        console.warn('Changelog check on mount:', err);
      }
    };

    checkChangelog();
  }, []);
}
