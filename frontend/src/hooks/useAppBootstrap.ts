import { useEffect, useState } from 'react';
import { useAuthBootstrap } from './useAuthBootstrap';
import { useChangelogBootstrap } from './useChangelogBootstrap';
import { useFlagsStore } from '../store/index';
import { ApiClient } from '../services/api/index';

export function useAppBootstrap() {
  const [appReady, setAppReady] = useState(false);
  const { setFlags } = useFlagsStore();

  useAuthBootstrap();
  useChangelogBootstrap();

  useEffect(() => {
    let isMounted = true;

    const loadFeatureFlags = async () => {
      try {
        const flags = await ApiClient.getFeatureFlags();
        if (isMounted) {
          setFlags(flags);
        }
      } catch {
        // Ignore feature-flag bootstrap failures and keep the default UI fallback.
      }
    };

    loadFeatureFlags();

    const timer = window.setTimeout(() => {
      if (isMounted) setAppReady(true);
    }, 800);

    return () => {
      isMounted = false;
      window.clearTimeout(timer);
    };
  }, [setFlags]);

  return { appReady };
}
