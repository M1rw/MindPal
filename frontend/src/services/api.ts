/**
 * MindPal API Client
 * Bound to contracts/openapi.yaml — all paths must match that spec.
 * Auth tokens are read from Zustand session store (in-memory only, never localStorage).
 */

import { useSessionStore } from '../store';
import type {
  MemorySummaryResponse,
  VoiceTokenResponse,
  FeatureChangelogItem,
  UserProfile,
  UsageQuota,
  HealthStatus,
  FeatureSnapshot,
  MemoryAtom,
} from '../types';
import { getApiBaseUrl } from './config';

async function fetchWithAuth(path: string, options: RequestInit = {}): Promise<Response> {
  const { idToken, appCheckToken } = useSessionStore.getState();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (idToken) {
    headers['Authorization'] = `Bearer ${idToken}`;
  }
  if (appCheckToken) {
    headers['X-Firebase-AppCheck'] = appCheckToken;
  }

  const baseUrl = getApiBaseUrl();
  // Strip /api prefix from path if baseUrl already ends with /api
  const cleanPath = baseUrl.endsWith('/api') && path.startsWith('/api')
    ? path.slice(4)
    : path;

  const url = `${baseUrl}${cleanPath}`;
  return fetch(url, { ...options, headers });
}

export const ApiClient = {
  // ─────────────────────────────────────────────
  // Health
  // ─────────────────────────────────────────────
  async getHealth(): Promise<HealthStatus> {
    const res = await fetch(`${getApiBaseUrl()}/health`);
    if (!res.ok) throw new Error(`Health check failed: ${res.statusText}`);
    return res.json();
  },

  async getHealthReady(): Promise<{ status: string }> {
    const res = await fetch(`${getApiBaseUrl()}/health/ready`);
    if (!res.ok) throw new Error(`Health ready failed: ${res.statusText}`);
    return res.json();
  },

  // ─────────────────────────────────────────────
  // Chat
  // ─────────────────────────────────────────────
  async streamChat(
    message: string,
    history: Array<{ role: string; content: string }>,
    onChunk: (chunk: string, strategy?: string) => void,
    onComplete: () => void,
    onError: (err: Error) => void,
    options?: { model?: string; telemetry?: any },
  ): Promise<void> {
    try {
      const res = await fetchWithAuth('/api/chat/stream', {
        method: 'POST',
        body: JSON.stringify({
          message,
          history,
          stream: true,
          model: options?.model || 'standard',
          telemetry: options?.telemetry,
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody?.detail || `Chat failed: ${res.status}`);
      }

      if (!res.body) throw new Error('Response body is null');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const rawData = line.slice(5).replace(/^ /, '');
          if (rawData === '[DONE]') {
            onComplete();
            return;
          }
          try {
            const data = JSON.parse(rawData);
            if (typeof data === 'object' && data !== null) {
              const textChunk: string = data.text ?? data.content ?? data.token ?? '';
              if (textChunk) onChunk(textChunk, data.strategy_used);
            } else if (typeof data === 'string') {
              onChunk(data);
            }
          } catch {
            // Raw text fallback if backend sends unescaped token string
            if (rawData) {
              onChunk(rawData);
            }
          }
        }
      }
      onComplete();
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  },

  async getCurrentChat(): Promise<any> {
    const res = await fetchWithAuth('/api/chats/current');
    if (!res.ok) throw new Error(`Get chat error: ${res.statusText}`);
    return res.json();
  },

  async replaceCurrentChat(chatData: any): Promise<any> {
    const res = await fetchWithAuth('/api/chats/current', {
      method: 'PUT',
      body: JSON.stringify(chatData),
    });
    if (!res.ok) throw new Error(`Replace chat error: ${res.statusText}`);
    return res.json();
  },

  async deleteCurrentChat(): Promise<void> {
    const res = await fetchWithAuth('/api/chats/current', { method: 'DELETE' });
    if (!res.ok) throw new Error(`Delete chat error: ${res.statusText}`);
  },

  async appendChatMessage(role: string, content: string): Promise<any> {
    const res = await fetchWithAuth('/api/chats/current/messages', {
      method: 'POST',
      body: JSON.stringify({ role, content }),
    });
    if (!res.ok) throw new Error(`Append message error: ${res.statusText}`);
    return res.json();
  },

  // ─────────────────────────────────────────────
  // Identity / User Profile
  // ─────────────────────────────────────────────
  async getUserMe(): Promise<any> {
    const res = await fetchWithAuth('/api/user/me');
    if (!res.ok) throw new Error(`User me error: ${res.statusText}`);
    return res.json();
  },

  async getUserProfile(): Promise<UserProfile> {
    const res = await fetchWithAuth('/api/user/profile');
    if (!res.ok) throw new Error(`Profile error: ${res.statusText}`);
    return res.json();
  },

  async patchUserProfile(data: Partial<UserProfile>): Promise<UserProfile> {
    const res = await fetchWithAuth('/api/user/profile', {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`Patch profile error: ${res.statusText}`);
    return res.json();
  },

  async getUserInsights(): Promise<any> {
    const res = await fetchWithAuth('/api/user/insights');
    if (!res.ok) throw new Error(`User insights error: ${res.statusText}`);
    return res.json();
  },

  async exportUserData(): Promise<Blob> {
    const res = await fetchWithAuth('/api/user/export');
    if (!res.ok) throw new Error(`Export error: ${res.statusText}`);
    return res.blob();
  },

  async deleteUserData(): Promise<void> {
    const res = await fetchWithAuth('/api/user/data', { method: 'DELETE' });
    if (!res.ok) throw new Error(`Delete user data error: ${res.statusText}`);
  },

  // ─────────────────────────────────────────────
  // Memory
  // ─────────────────────────────────────────────
  async getMemorySummary(): Promise<MemorySummaryResponse> {
    const res = await fetchWithAuth('/api/memory/summary');
    if (!res.ok) throw new Error(`Memory summary error: ${res.statusText}`);
    return res.json();
  },

  async refreshMemorySummary(): Promise<MemorySummaryResponse> {
    const res = await fetchWithAuth('/api/memory/summary/refresh', { method: 'POST' });
    if (!res.ok) throw new Error(`Memory refresh error: ${res.statusText}`);
    return res.json();
  },

  async getMemoryGraph(): Promise<{ atoms: MemoryAtom[] }> {
    const res = await fetchWithAuth('/api/memory/graph');
    if (!res.ok) throw new Error(`Memory graph error: ${res.statusText}`);
    return res.json();
  },

  async putMemoryGraph(graph: { atoms: MemoryAtom[] }): Promise<any> {
    const res = await fetchWithAuth('/api/memory/graph', {
      method: 'PUT',
      body: JSON.stringify(graph),
    });
    if (!res.ok) throw new Error(`Update memory graph error: ${res.statusText}`);
    return res.json();
  },

  async deleteMemoryGraphItem(atomId: string): Promise<any> {
    const res = await fetchWithAuth(`/api/memory/graph/items/${encodeURIComponent(atomId)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`Delete memory atom error: ${res.statusText}`);
    return res.json();
  },

  // ─────────────────────────────────────────────
  // Voice
  // ─────────────────────────────────────────────
  async getVoiceSessionToken(): Promise<VoiceTokenResponse> {
    const res = await fetchWithAuth('/api/voice/session-token', { method: 'POST' });
    if (!res.ok) throw new Error(`Voice session token error: ${res.statusText}`);
    return res.json();
  },

  // ─────────────────────────────────────────────
  // Feature Flags
  // ─────────────────────────────────────────────
  async getFeatureFlags(): Promise<FeatureSnapshot> {
    const res = await fetchWithAuth('/api/features');
    if (!res.ok) throw new Error(`Features error: ${res.statusText}`);
    return res.json();
  },

  // ─────────────────────────────────────────────
  // Changelog / Release
  // ─────────────────────────────────────────────
  async getChangelog(): Promise<FeatureChangelogItem[]> {
    const res = await fetchWithAuth('/api/release/changelog');
    if (!res.ok) throw new Error(`Changelog error: ${res.statusText}`);
    return res.json();
  },

  async dismissChangelog(version: string): Promise<void> {
    const res = await fetchWithAuth('/api/release/changelog', {
      method: 'POST',
      body: JSON.stringify({ version }),
    });
    if (!res.ok) throw new Error(`Dismiss changelog error: ${res.statusText}`);
  },
};
