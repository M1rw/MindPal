import { useCallback, useEffect, useState } from 'react';
import { ApiClient } from '../../services/api/index.ts';
import { useAuthStore, useChatHistoryStore, useChatStore, useSessionStore } from '../../store/index.ts';
import { loadGuestGraph } from '../../utils/memory/guestMemory.ts';
import { loadWellnessTimeline, localDeviceWellness } from '../../utils/wellness/load.ts';
import type { WellnessTimeline } from '../../types/index.ts';

export function useWellnessTimeline(enabled: boolean): {
  data: WellnessTimeline | null;
  loading: boolean;
  error: string | null;
  signedIn: boolean;
  refresh: () => void;
} {
  const user = useAuthStore((state) => state.user);
  const authLoading = useAuthStore((state) => state.isLoading);
  const idToken = useSessionStore((state) => state.idToken);
  const authenticated = useSessionStore((state) => state.isAuthenticated);
  const canCallAccount = Boolean(user && authenticated && idToken);
  const sessions = useChatHistoryStore((state) => state.sessions);
  const liveMessages = useChatStore((state) => state.messages);
  const [data, setData] = useState<WellnessTimeline | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    if (authLoading) {
      setLoading(true);
      return;
    }

    const local = () =>
      localDeviceWellness({
        atoms: loadGuestGraph().atoms,
        sessions,
        extraMessages: liveMessages,
      });

    if (!canCallAccount) {
      setData(local());
      setError(null);
      setSignedIn(false);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    void loadWellnessTimeline({
      signedIn: true,
      fetchAccount: () => ApiClient.getWellnessTimeline(),
      local,
    }).then((result) => {
      if (cancelled) return;
      setData(result.data);
      setError(result.error);
      setSignedIn(result.signedIn);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    authLoading,
    canCallAccount,
    tick,
    canCallAccount ? null : sessions,
    canCallAccount ? null : liveMessages,
  ]);

  return { data, loading, error, signedIn, refresh };
}
