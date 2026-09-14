import { useSettingsStore } from '../../store/index.ts';
import type { UserPersonalization } from '../../types/index.ts';
import { fetchJson, fetchWithAuth, expectOk, parseErrorMessage } from './http.ts';

export const chatApi = {
  async streamChat(
    message: string,
    history: Array<{ role: string; content: string }>,
    onChunk: (chunk: string, strategy?: string) => void,
    onComplete: () => void,
    onError: (err: Error) => void,
    options?: {
      model?: string;
      telemetry?: unknown;
      personalization?: UserPersonalization;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    try {
      const activePersonalization = options?.personalization ?? useSettingsStore.getState().settings.personalization;
      const response = await fetchWithAuth('/api/chat/stream', {
        method: 'POST',
        signal: options?.signal,
        body: JSON.stringify({
          message,
          history,
          stream: true,
          model: options?.model || 'standard',
          telemetry: options?.telemetry,
          personalization: activePersonalization,
        }),
      });

      if (!response.ok) {
        const detail = await parseErrorMessage(response, 'Chat failed');
        throw new Error(detail);
      }

      if (!response.body) throw new Error('Response body is null');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        if (options?.signal?.aborted) {
          try {
            await reader.cancel();
          } catch {
            // ignore
          }
          onComplete();
          return;
        }

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
            if (rawData) {
              onChunk(rawData);
            }
          }
        }
      }

      onComplete();
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.message?.toLowerCase().includes('abort'))) {
        onComplete();
        return;
      }
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  },

  async getCurrentChat(): Promise<unknown> {
    return fetchJson<unknown>('/api/chats/current', undefined, 'Get chat error');
  },

  async replaceCurrentChat(chatData: unknown): Promise<unknown> {
    return fetchJson<unknown>('/api/chats/current', {
      method: 'PUT',
      body: JSON.stringify(chatData),
    }, 'Replace chat error');
  },

  async deleteCurrentChat(): Promise<void> {
    await expectOk('/api/chats/current', { method: 'DELETE' }, 'Delete chat error');
  },

  async appendChatMessage(role: string, content: string): Promise<unknown> {
    return fetchJson<unknown>('/api/chats/current/messages', {
      method: 'POST',
      body: JSON.stringify({ role, content }),
    }, 'Append message error');
  },
};
