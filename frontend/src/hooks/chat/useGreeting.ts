/**
 * useGreeting — Smart contextual greeting hook.
 *
 * Two-layer cache:
 *   Layer 1: localStorage (same date+period+uid) → zero network calls
 *   Layer 2: Backend store (same cache key) → zero AI calls on server cache hit
 *
 * Falls back to pure-JS heuristic if API is unavailable or user is unauthenticated.
 */

import { useState, useEffect } from 'react';
import { ApiClient } from '../../services/api/index';

interface GreetingCache {
  text: string;
  tone: string;
  period: string;
  date: string;
  uid: string;
}

const CACHE_KEY = 'mp_greeting';

function getTimePeriod(hour: number): string {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

function getFallbackGreeting(displayName?: string | null, hour?: number): string {
  const h = hour ?? new Date().getHours();
  const salutations: Record<string, string> = {
    morning: 'Good morning',
    afternoon: 'Good afternoon',
    evening: 'Good evening',
    night: 'Good evening',
  };
  const salutation = salutations[getTimePeriod(h)];
  const firstName = displayName?.trim().split(' ')[0];
  return firstName ? `${salutation}, ${firstName}.` : `${salutation}.`;
}

export function useGreeting(user: { uid?: string; displayName?: string | null } | null) {
  const [greeting, setGreeting] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const period = getTimePeriod(now.getHours());
    const uid = user?.uid ?? 'anon';

    // Layer 1: localStorage cache — zero network calls
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const cached: GreetingCache = JSON.parse(raw);
        if (cached.date === date && cached.period === period && cached.uid === uid) {
          setGreeting(cached.text);
          setIsLoading(false);
          return;
        }
      }
    } catch {
      // Ignore malformed cache entry
    }

    // No auth → instant JS fallback, no API call
    if (!user?.uid) {
      setGreeting(getFallbackGreeting(user?.displayName));
      setIsLoading(false);
      return;
    }

    // Layer 2: fetch from backend (server cache checked there too)
    const tzOffset = -now.getTimezoneOffset(); // minutes east of UTC (matches Python timedelta)
    ApiClient.getGreeting(tzOffset, user.displayName ?? undefined)
      .then((res) => {
        setGreeting(res.greeting);
        const cache: GreetingCache = {
          text: res.greeting,
          tone: res.tone,
          period: res.period ?? period,
          date,
          uid,
        };
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
        } catch {
          // Ignore storage quota errors
        }
      })
      .catch(() => {
        setGreeting(getFallbackGreeting(user.displayName));
      })
      .finally(() => setIsLoading(false));
  }, [user?.uid]);

  return { greeting, isLoading };
}
