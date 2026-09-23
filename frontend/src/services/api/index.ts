import { chatApi, syncUsage } from './chat.ts';
import { chatsApi } from './chats.ts';
import { usersApi } from './users.ts';
import { memoryApi } from './memory.ts';
import { voiceApi } from './voice.ts';
import type {
  MemorySummaryResponse,
  VoiceTokenResponse,
  UserProfile,
  UserInsightsResponse,
  WellnessTimeline,
  HealthStatus,
  FeatureSnapshot,
  MemoryAtom,
  ChangelogResponse,
  ChatSession,
  UserPersonalization,
} from '../../types/index.ts';
import { fetchJson, fetchBlob, expectOk } from './http.ts';

/** What MindPal has learned about how to talk with this person (style only). */
export interface AdaptiveProfileSummary {
  enabled: boolean;
  turns_observed: number;
  preferences: Record<string, string>;
  strategies: Record<string, { score: number; evidence: number }>;
  note: string;
  updated_at: number;
}

export { fetchJson, fetchBlob, expectOk };

export const ApiClient = {
  // Chat
  streamChat: chatApi.streamChat,

  // Multi-Session Chat Cloud Persistence
  listChatSessions: chatsApi.listChatSessions,
  saveChatSession: chatsApi.saveChatSession,
  deleteChatSession: chatsApi.deleteChatSession,

  // Identity / User Profile
  getUserProfile: usersApi.getUserProfile,
  patchUserProfile: usersApi.patchUserProfile,
  getUserInsights: usersApi.getUserInsights,
  getWellnessTimeline: usersApi.getWellnessTimeline,
  exportUserData: usersApi.exportUserData,
  deleteUserData: usersApi.deleteUserData,

  // Memory
  getMemorySummary: memoryApi.getMemorySummary,
  refreshMemorySummary: memoryApi.refreshMemorySummary,
  forgetMemoryNarrative: memoryApi.forgetMemoryNarrative,
  getMemoryGraph: memoryApi.getMemoryGraph,
  putMemoryGraph: memoryApi.putMemoryGraph,
  patchMemoryGraphItem: memoryApi.patchMemoryGraphItem,
  deleteMemoryGraphItem: memoryApi.deleteMemoryGraphItem,
  mergeGuestGraphIntoAccount: memoryApi.mergeGuestGraphIntoAccount,

  // Voice
  summarizeVoiceSession: voiceApi.summarizeVoiceSession,

  // Feature Flags
  async getFeatureFlags(): Promise<FeatureSnapshot> {
    const data = await fetchJson<FeatureSnapshot & { flags?: FeatureSnapshot }>(
      '/api/features',
      undefined,
      'Features error',
    );
    const inner = data.flags ?? data;
    return {
      voice_enabled: Boolean(inner.voice_enabled),
      presence_enabled: inner.presence_enabled,
      pro_model_enabled: Boolean(inner.pro_model_enabled),
      memory_enabled: Boolean(inner.memory_enabled),
      changelog_enabled: Boolean(inner.changelog_enabled),
      clinical_guidance: inner.clinical_guidance,
      analytics_insights: inner.analytics_insights,
    };
  },

  // Changelog / Release
  /** Current chat credits without spending one; refreshes the usage store. */
  async refreshUsage(): Promise<void> {
    const body = await fetchJson<{ chat?: unknown }>('/api/usage', undefined, 'Usage unavailable');
    syncUsage(body?.chat);
  },

  async getChangelog(): Promise<ChangelogResponse> {
    return fetchJson<ChangelogResponse>('/api/release/changelog', undefined, 'Changelog error');
  },

  /** Thumbs up/down on a reply; the server learns which approaches help this person. */
  async rateReply(rating: 'up' | 'down', strategy?: string): Promise<void> {
    await expectOk('/api/chat/feedback', {
      method: 'POST',
      body: JSON.stringify(strategy ? { rating, strategy } : { rating }),
    }, 'Reply feedback error');
  },

  async getAdaptation(): Promise<AdaptiveProfileSummary> {
    return fetchJson<AdaptiveProfileSummary>('/api/user/adaptation', { method: 'GET' }, 'Adaptive profile unavailable');
  },

  async resetAdaptation(): Promise<void> {
    await expectOk('/api/user/adaptation', { method: 'DELETE' }, 'Adaptive profile reset error');
  },

  async dismissChangelog(version: string): Promise<void> {
    await expectOk('/api/release/changelog', {
      method: 'POST',
      body: JSON.stringify({ version }),
    }, 'Dismiss changelog error');
  },

  async getGreeting(
    tzOffsetMinutes: number,
    displayName?: string,
  ): Promise<{ greeting: string; tone: string; period: string; cached: boolean }> {
    const params = new URLSearchParams({ tz_offset: String(tzOffsetMinutes) });
    if (displayName) params.set('display_name', displayName);
    return fetchJson<{ greeting: string; tone: string; period: string; cached: boolean }>(
      `/api/greeting?${params.toString()}`,
      undefined,
      'Greeting error',
    );
  },
};

export type {
  MemorySummaryResponse,
  VoiceTokenResponse,
  UserProfile,
  UserInsightsResponse,
  WellnessTimeline,
  HealthStatus,
  FeatureSnapshot,
  MemoryAtom,
  ChangelogResponse,
  ChatSession,
  UserPersonalization,
};
