import { chatApi } from './chat';
import { chatsApi } from './chats';
import { usersApi } from './users';
import { memoryApi } from './memory';
import type {
  MemorySummaryResponse,
  VoiceTokenResponse,
  UserProfile,
  UserInsightsResponse,
  HealthStatus,
  FeatureSnapshot,
  MemoryAtom,
  ChangelogResponse,
  ChatSession,
  UserPersonalization,
} from '../../types';
import { fetchJson, fetchBlob, expectOk } from './http';

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
  exportUserData: usersApi.exportUserData,
  deleteUserData: usersApi.deleteUserData,

  // Memory
  getMemorySummary: memoryApi.getMemorySummary,
  refreshMemorySummary: memoryApi.refreshMemorySummary,
  getMemoryGraph: memoryApi.getMemoryGraph,
  putMemoryGraph: memoryApi.putMemoryGraph,
  deleteMemoryGraphItem: memoryApi.deleteMemoryGraphItem,

  // Voice
  async getVoiceSessionToken(): Promise<VoiceTokenResponse> {
    return fetchJson<VoiceTokenResponse>('/api/voice/session-token', { method: 'POST' }, 'Voice session token error');
  },

  // Feature Flags
  async getFeatureFlags(): Promise<FeatureSnapshot> {
    return fetchJson<FeatureSnapshot>('/api/features', undefined, 'Features error');
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
  HealthStatus,
  FeatureSnapshot,
  MemoryAtom,
  ChangelogResponse,
  ChatSession,
  UserPersonalization,
};
