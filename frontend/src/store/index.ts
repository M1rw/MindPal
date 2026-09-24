/**
 * MindPal store barrel file.
 * Phase 2 Tier-1 architecture cleanup: keep a thin public entry point and move
 * store logic into dedicated modules.
 */

export { useSessionStore } from './session.ts';
export { useAuthStore } from './auth.ts';
export { useChatStore } from './chat.ts';
export { useVoiceStore } from './voice.ts';
export { useMemoryStore } from './memory.ts';
export { useSettingsStore } from './settings.ts';
export { useToastStore } from './toast.ts';
export { useStreakStore } from './streak.ts';
export { useChatHistoryStore } from './history.ts';
export { useFlagsStore } from './flags.ts';
export { usePaletteStore } from './palette.ts';
export { useUsageStore } from './usage.ts';
export { useChangelogStore } from './changelog.ts';
export { useChatHistoryModalStore } from './modals.ts';

export type { AuthUser, ChatMessage, ChatSession, ChangelogResponse, FeatureSnapshot, MemorySummaryResponse, StreakData, ToastItem, ToastKind, UsageQuota, UserUISettings } from '../types/index';
