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

function readCache(): GreetingCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as GreetingCache) : null;
  } catch {
    return null;
  }
}

/**
 * What the headline says on the very first render: today's greeting from this
 * browser if there is one, else the time-of-day line. The home screen used to
 * show a skeleton until Firebase finished restoring the session and the
 * greeting API answered; on a phone that held the page's largest text (its
 * LCP) back by several seconds after everything had downloaded.
 */
function firstGreeting(): string {
  const now = new Date();
  const cached = readCache();
  if (cached && cached.date === now.toISOString().slice(0, 10) && cached.period === getTimePeriod(now.getHours())) {
    return cached.text;
  }
  return getFallbackGreeting(null);
}

export function useGreeting(user: { uid?: string; displayName?: string | null } | null, authLoading = false) {
  const [greeting, setGreeting] = useState(firstGreeting);

  useEffect(() => {
    // Until sign-in has resolved, keep what is on screen: acting on "no user"
    // here would swap the cached greeting for the generic one and back.
    if (authLoading) return;
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const period = getTimePeriod(now.getHours());
    const uid = user?.uid ?? 'anon';

    // Layer 1: localStorage cache — zero network calls
    const cached = readCache();
    if (cached && cached.date === date && cached.period === period && cached.uid === uid) {
      setGreeting(cached.text);
      return;
    }

    // No auth → instant JS fallback, no API call
    if (!user?.uid) {
      setGreeting(getFallbackGreeting(user?.displayName));
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
      });
  }, [user?.uid, authLoading]);

  // Never "loading": there is always a greeting to show.
  return { greeting, isLoading: false };
}
