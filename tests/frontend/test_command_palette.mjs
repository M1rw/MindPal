import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { confirmAction, useConfirmStore } from '../../frontend/src/store/confirm.ts';
import { searchChats, snippetAround, searchTerms } from '../../frontend/src/utils/ui/search.ts';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    clear: () => data.clear(),
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true, writable: true });
  useConfirmStore.setState({ queue: [] });
});

describe('confirm dialog store', () => {
  it('resolves with the answer and queues requests one after another', async () => {
    const first = confirmAction({ title: 'Delete this chat?', tone: 'danger' });
    const second = confirmAction({ title: 'Start a new chat?' });
    const queue = useConfirmStore.getState().queue;
    assert.deepEqual(queue.map((r) => r.title), ['Delete this chat?', 'Start a new chat?']);
    useConfirmStore.getState().settle(queue[0].id, false);
    assert.equal(await first, false);
    useConfirmStore.getState().settle(useConfirmStore.getState().queue[0].id, true);
    assert.equal(await second, true);
    assert.equal(useConfirmStore.getState().queue.length, 0);
  });

  it('remembers "Don\'t ask again" only when confirmed with it ticked', async () => {
    const asked = confirmAction({ title: 'Start a new chat?', dontAskAgainKey: 'new-chat' });
    useConfirmStore.getState().settle(useConfirmStore.getState().queue[0].id, true, true);
    assert.equal(await asked, true);
    assert.equal(await confirmAction({ title: 'Start a new chat?', dontAskAgainKey: 'new-chat' }), true);
    assert.equal(useConfirmStore.getState().queue.length, 0, 'answered without showing');
  });

  it('a cancel with the box ticked does not suppress future questions', async () => {
    const asked = confirmAction({ title: 'Start a new chat?', dontAskAgainKey: 'new-chat' });
    useConfirmStore.getState().settle(useConfirmStore.getState().queue[0].id, false, true);
    assert.equal(await asked, false);
    void confirmAction({ title: 'Start a new chat?', dontAskAgainKey: 'new-chat' });
    assert.equal(useConfirmStore.getState().queue.length, 1);
  });
});

describe('palette search', () => {
  const chat = (id, title, ...lines) => ({
    id,
    title,
    createdAt: '2026-09-20T10:00:00Z',
    updatedAt: '2026-09-20T10:00:00Z',
    messages: lines.map((content, i) => ({ id: `${id}-${i}`, role: 'user', content, timestamp: '2026-09-20T10:00:00Z' })),
  });
  const sessions = [
    chat('a', 'Exam stress', 'The chemistry exam is on Friday'),
    chat('b', 'Weekend plans', 'Maybe a walk with my sister Noor, then study for the exam'),
    chat('c', 'Work', 'My manager was kind today'),
  ];

  it('needs every word, in any order, and puts title matches first', () => {
    const results = searchChats(sessions, 'exam');
    assert.deepEqual(results.map((r) => r.session.id), ['a', 'b']);
    assert.equal(results[0].snippet, undefined, 'a title match needs no snippet');
    assert.match(results[1].snippet, /exam/);
    assert.deepEqual(searchChats(sessions, 'noor walk').map((r) => r.session.id), ['b']);
    assert.deepEqual(searchChats(sessions, 'noor manager'), []);
  });

  it('shows a short window around the match', () => {
    const long = `${'x '.repeat(80)}the important sentence about Noor ${'y '.repeat(80)}`;
    const snippet = snippetAround(long, searchTerms('noor'));
    assert.ok(snippet.startsWith('…') && snippet.endsWith('…'));
    assert.ok(snippet.toLowerCase().includes('noor'));
    assert.ok(snippet.length < 100);
  });
});
