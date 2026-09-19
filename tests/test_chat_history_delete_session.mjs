import test from 'node:test';
import assert from 'node:assert/strict';

import { useChatHistoryStore } from '../frontend/src/store/history.ts';
import { useChatStore } from '../frontend/src/store/chat.ts';

test('deleting the active chat clears the current chat and resets the active session', () => {
  useChatHistoryStore.setState({
    sessions: [
      {
        id: 'sess-1',
        title: 'Active chat',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: '2024-01-01T00:00:00.000Z' }],
      },
    ],
    activeSessionId: 'sess-1',
  });

  useChatStore.setState({
    messages: [
      { id: 'm1', role: 'user', content: 'hello', timestamp: '2024-01-01T00:00:00.000Z' },
      { id: 'm2', role: 'assistant', content: 'hi', timestamp: '2024-01-01T00:00:01.000Z' },
    ],
    composerDraft: 'draft',
    editingUserId: 'user-1',
  });

  useChatHistoryStore.getState().deleteSession('sess-1');

  assert.equal(useChatHistoryStore.getState().activeSessionId, null);
  assert.deepEqual(useChatStore.getState().messages, []);
  assert.equal(useChatStore.getState().composerDraft, null);
  assert.equal(useChatStore.getState().editingUserId, null);
});
