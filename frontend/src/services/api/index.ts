import { chatApi } from './chat.ts';
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

export { fetchJson, fetchBlob, expectOk };

export const ApiClient = {
  // Health
  async getHealth(): Promise<HealthStatus> {
    return fetchJson<HealthStatus>('/api/health', undefined, 'Health check failed');
  },

  async getHealthReady(): Promise<{ status: string }> {
    return fetchJson<{ status: string }>('/api/health/ready', undefined, 'Health ready failed');
  },

  // Chat
  streamChat: chatApi.streamChat,
  getCurrentChat: chatApi.getCurrentChat,
  replaceCurrentChat: chatApi.replaceCurrentChat,
  deleteCurrentChat: chatApi.deleteCurrentChat,
  appendChatMessage: chatApi.appendChatMessage,

  // Multi-Session Chat Cloud Persistence
  listChatSessions: chatsApi.listChatSessions,
  saveChatSession: chatsApi.saveChatSession,
  getChatSession: chatsApi.getChatSession,
  deleteChatSession: chatsApi.deleteChatSession,

  // Identity / User Profile
  getUserMe: usersApi.getUserMe,
  getUserProfile: usersApi.getUserProfile,
  patchUserProfile: usersApi.patchUserProfile,
  getUserInsights: usersApi.getUserInsights,
  getWellnessTimeline: usersApi.getWellnessTimeline,
  exportUserData: usersApi.exportUserData,
  deleteUserData: usersApi.deleteUserData,

  // Memory
  getMemorySummary: memoryApi.getMemorySummary,
  refreshMemorySummary: memoryApi.refreshMemorySummary,
  getMemoryGraph: memoryApi.getMemoryGraph,
  putMemoryGraph: memoryApi.putMemoryGraph,
  patchMemoryGraphItem: memoryApi.patchMemoryGraphItem,
  deleteMemoryGraphItem: memoryApi.deleteMemoryGraphItem,
  mergeGuestGraphIntoAccount: memoryApi.mergeGuestGraphIntoAccount,

  // Voice
  mintVoiceSession: voiceApi.mintVoiceSession,
  recordVoiceSessionEvent: voiceApi.recordVoiceSessionEvent,
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
  async getChangelog(): Promise<ChangelogResponse> {
    return fetchJson<ChangelogResponse>('/api/release/changelog', undefined, 'Changelog error');
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
