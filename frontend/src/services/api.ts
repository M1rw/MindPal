import { useSessionStore } from '../store';
import { MemorySummaryResponse, VoiceTokenResponse, FeatureChangelogItem } from '../types';

function getApiBaseUrl(): string {
  if (typeof window !== 'undefined' && (window as any).MINDPAL_CONFIG?.API_BASE_URL) {
    return (window as any).MINDPAL_CONFIG.API_BASE_URL.replace(/\/$/, '');
  }
  return '';
}

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

  const url = `${getApiBaseUrl()}${path}`;
  const response = await fetch(url, { ...options, headers });
  return response;
}

export const ApiClient = {
  async getMemorySummary(): Promise<MemorySummaryResponse> {
    const res = await fetchWithAuth('/api/memory/summary');
    if (!res.ok) throw new Error(`Memory API error: ${res.statusText}`);
    return res.json();
  },

  async refreshMemorySummary(): Promise<MemorySummaryResponse> {
    const res = await fetchWithAuth('/api/memory/summary/refresh', { method: 'POST' });
    if (!res.ok) throw new Error(`Memory Refresh API error: ${res.statusText}`);
    return res.json();
  },

  async updateMemorySummary(summary: string): Promise<MemorySummaryResponse> {
    const res = await fetchWithAuth('/api/memory/summary', {
      method: 'PUT',
      body: JSON.stringify({ summary }),
    });
    if (!res.ok) throw new Error(`Memory Update API error: ${res.statusText}`);
    return res.json();
  },

  async getVoiceToken(): Promise<VoiceTokenResponse> {
    const res = await fetchWithAuth('/api/voice/v4/token', { method: 'POST' });
    if (!res.ok) throw new Error(`Voice Token API error: ${res.statusText}`);
    return res.json();
  },

  async getChangelog(): Promise<FeatureChangelogItem[]> {
    const res = await fetchWithAuth('/api/features/changelog');
    if (!res.ok) throw new Error(`Changelog API error: ${res.statusText}`);
    return res.json();
  },

  async streamChat(
    message: string,
    history: any[],
    onChunk: (chunk: string, strategy?: string) => void,
    onComplete: () => void,
    onError: (err: Error) => void
  ): Promise<void> {
    try {
      const res = await fetchWithAuth('/api/chat/stream', {
        method: 'POST',
        body: JSON.stringify({ message, history, stream: true }),
      });

      if (!res.ok) {
        throw new Error(`Chat request failed with status ${res.status}`);
      }

      if (!res.body) {
        throw new Error('Response body is null');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);
            if (jsonStr === '[DONE]') {
              onComplete();
              return;
            }
            try {
              const data = JSON.parse(jsonStr);
              const textChunk = data.text || data.content || '';
              if (textChunk) {
                onChunk(textChunk, data.strategy_used);
              }
            } catch {
              // Ignore non-JSON line
            }
          }
        }
      }
      onComplete();
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  },
};
