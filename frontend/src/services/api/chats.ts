import { fetchJson, expectOk } from './http.ts';
import type { ChatSession } from '../../types/index.ts';

export const chatsApi = {
  async listChatSessions(): Promise<{ sessions: ChatSession[] }> {
    return fetchJson<{ sessions: ChatSession[] }>('/api/chats', undefined, 'List chats error');
  },

  async saveChatSession(session: ChatSession): Promise<ChatSession> {
    return fetchJson<ChatSession>('/api/chats', {
      method: 'POST',
      body: JSON.stringify(session),
    }, 'Save chat error');
  },

  async getChatSession(id: string): Promise<ChatSession> {
    return fetchJson<ChatSession>(`/api/chats/${encodeURIComponent(id)}`, undefined, 'Get chat session error');
  },

  async deleteChatSession(id: string): Promise<void> {
    await expectOk(`/api/chats/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Delete chat session error');
  },
};
