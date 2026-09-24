import { fetchJson, expectOk } from './http.ts';
import type { ChatMessage, ChatSession } from '../../types/index.ts';

/**
 * A saved session as the rest of the app expects it (audit MP-12).
 *
 * Rows saved before the server kept message ids come back without them. They
 * get ids derived from the session and position, so they are the same on every
 * load and on every device, instead of each view inventing its own.
 */
export function normalizeCloudSession(raw: unknown): ChatSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id : '';
  if (!id) return null;
  const createdAt = typeof row.createdAt === 'string' ? row.createdAt : new Date(0).toISOString();
  const messages = Array.isArray(row.messages) ? row.messages : [];
  return {
    id,
    title: typeof row.title === 'string' ? row.title : '',
    titleLocked: row.titleLocked === true,
    createdAt,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : createdAt,
    messages: messages
      .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === 'object')
      .map((m, index) => ({
        ...(m as unknown as ChatMessage),
        id: typeof m.id === 'string' && m.id ? m.id : `${id}:m${index}`,
        timestamp: typeof m.timestamp === 'string' ? m.timestamp : createdAt,
      })),
  };
}

export const chatsApi = {
  async listChatSessions(): Promise<{ sessions: ChatSession[] }> {
    const body = await fetchJson<{ sessions?: unknown }>('/api/chats', undefined, 'List chats error');
    const rows = Array.isArray(body?.sessions) ? body.sessions : [];
    return { sessions: rows.map(normalizeCloudSession).filter((s): s is ChatSession => s !== null) };
  },

  async saveChatSession(session: ChatSession): Promise<ChatSession> {
    // Device-only markers stay on the device.
    const { cloudDetached: _local, ...persisted } = session;
    void _local;
    return fetchJson<ChatSession>('/api/chats', {
      method: 'POST',
      body: JSON.stringify(persisted),
    }, 'Save chat error');
  },

  async deleteChatSession(id: string): Promise<void> {
    await expectOk(`/api/chats/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Delete chat session error');
  },
};
