/**
 * Centralized Storage Keys
 * Prevents magic string typos, guarantees single source of truth for localStorage / sessionStorage keys.
 */

export const STORAGE_KEYS = {
  THEME: 'mindpal_theme',
  SETTINGS: 'mindpal_settings_v1',
  STREAK: 'mindpal_streak',
  CHAT_SESSIONS: 'mindpal_chat_sessions',
  AUTH_LAST_USED: 'mindpal_auth_last_used',
  PRESENCE_WAITLIST: 'mindpal_presence_waitlist',
  LAST_SEEN_CHANGELOG: 'mindpal_last_seen_changelog',
  GREETING_CACHE: 'mindpal_greeting_cache_v2',
  GUEST_DEVICE_ID: 'mindpal_guest_device_id',
  GUEST_MEMORY: 'mindpal_guest_memory_v1',
} as const;

export function accountChangelogKey(accountId: string): string {
  return `${STORAGE_KEYS.LAST_SEEN_CHANGELOG}:${accountId}`;
}

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];
