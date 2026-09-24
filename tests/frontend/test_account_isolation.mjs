import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { STORAGE_KEYS } from '../../frontend/src/constants/storage.ts';
import { useChatHistoryStore, useSessionStore, useSettingsStore } from '../../frontend/src/store/index.ts';
import { setOwner, resetOwnerForTests } from '../../frontend/src/services/session/owner.ts';
import { historyKey } from '../../frontend/src/store/history.ts';
import { normalizeCloudSession } from '../../frontend/src/services/api/chats.ts';

/**
 * Audit phase 3: what the browser shows and sends belongs to the account that
 * owns it at that moment (MP-02, MP-19), requests stay stoppable after their
 * headers arrive (MP-13), saved chats keep their identity (MP-12), and chat
 * sends carry an idempotency key (MP-26).
 */

const realFetch = globalThis.fetch;

// A plain in-memory Storage: Node's built-in one here has no clear().
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
const session = (id, text) => ({
  id,
  title: text,
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
  messages: [{ id: `${id}-u`, role: 'user', content: text, timestamp: '2026-09-20T10:00:00.000Z' }],
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

function signIn(uid) {
  setOwner(uid);
  useChatHistoryStore.getState().switchOwner(uid ?? 'guest');
  useSessionStore.setState({ isAuthenticated: Boolean(uid), idToken: uid ? `token-${uid}` : null, userId: uid });
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true, writable: true });
  resetOwnerForTests();
  useChatHistoryStore.setState({ sessions: [], owner: 'guest', activeSessionId: null, guestSessionCount: 0 });
  useSessionStore.setState({ isAuthenticated: false, idToken: null, userId: null });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  resetOwnerForTests();
  useChatHistoryStore.setState({ owner: 'guest', sessions: [] });
});

describe('MP-02: chat history belongs to one account', () => {
  it('never shows or uploads account A history to a guest or to account B', async () => {
    const sent = [];
    globalThis.fetch = async (url, init) => {
      sent.push({ url: String(url), auth: new Headers(init?.headers).get('Authorization'), body: String(init?.body || '') });
      return new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    signIn('usr_a');
    useChatHistoryStore.getState().saveSession(session('a1', 'A private reflection'));
    await flush();
    assert.ok(localStorage.getItem(historyKey('usr_a')).includes('A private reflection'));

    signIn(null);
    assert.deepEqual(useChatHistoryStore.getState().sessions, [], 'guest sees none of A');
    signIn('usr_b');
    assert.deepEqual(useChatHistoryStore.getState().sessions, [], 'B sees none of A');
    await flush();
    assert.ok(!sent.some((r) => r.auth === 'Bearer token-usr_b' && r.body.includes('A private reflection')));
  });

  it('drops a sync scheduled for A when B signs in before it runs', async () => {
    const sent = [];
    globalThis.fetch = async (_url, init) => {
      sent.push(String(init?.body || ''));
      return new Response('{}', { status: 200 });
    };
    signIn('usr_a');
    useChatHistoryStore.getState().saveSession(session('a2', 'written as A'));
    signIn('usr_b'); // before the deferred cloud call resolves
    await flush();
    assert.ok(!sent.some((body) => body.includes('written as A')));
  });

  it('adds guest chats to an account only when asked', async () => {
    globalThis.fetch = async () => new Response('{}', { status: 200 });
    useChatHistoryStore.getState().saveSession(session('g1', 'guest chat'));
    signIn('usr_a');
    assert.equal(useChatHistoryStore.getState().sessions.length, 0);
    assert.equal(useChatHistoryStore.getState().guestSessionCount, 1);
    assert.equal(useChatHistoryStore.getState().importGuestSessions(), 1);
    assert.equal(useChatHistoryStore.getState().sessions[0].id, 'g1');
    assert.equal(JSON.parse(localStorage.getItem(STORAGE_KEYS.CHAT_SESSIONS)).length, 0);
  });

  it('discards a cloud list that arrives after the account changed', async () => {
    let release;
    globalThis.fetch = () =>
      new Promise((resolve) => {
        release = () => resolve(new Response(JSON.stringify({ sessions: [session('a3', 'A cloud chat')] }), { status: 200 }));
      });
    signIn('usr_a');
    const loading = useChatHistoryStore.getState().loadCloudSessions();
    await flush();
    signIn('usr_b');
    release();
    await loading;
    assert.ok(!useChatHistoryStore.getState().sessions.some((s) => s.id === 'a3'));
  });

  it('never re-uploads local copies after account data deletion', async () => {
    const sent = [];
    globalThis.fetch = async (_url, init) => {
      sent.push(String(init?.body || ''));
      return new Response('{}', { status: 200 });
    };
    signIn('usr_a');
    useChatHistoryStore.getState().saveSession(session('a4', 'old conversation'));
    await flush();
    sent.length = 0;
    useChatHistoryStore.getState().detachFromCloud();
    useChatHistoryStore.getState().renameSession('a4', 'renamed later');
    useChatHistoryStore.getState().saveSession({ ...session('a4', 'edited later') });
    await flush();
    assert.deepEqual(sent, []);
  });
});

describe('MP-19: settings stay with their account', () => {
  it('a profile answer for A is not applied or pushed after B signs in', async () => {
    const { pullAccountSettings } = await import('../../frontend/src/services/sync/settingsSync.ts');
    const patches = [];
    let release;
    globalThis.fetch = (url, init) => {
      if ((init?.method || 'GET') === 'PATCH') {
        patches.push(String(init.body));
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return new Promise((resolve) => {
        release = () => resolve(new Response(JSON.stringify({ settings: { voiceModel: 'Aoede' } }), { status: 200 }));
      });
    };
    useSettingsStore.getState().updateSettings({ voiceModel: 'Puck' });
    signIn('usr_a');
    const pulling = pullAccountSettings();
    await flush();
    signIn('usr_b');
    release();
    await pulling;
    assert.equal(useSettingsStore.getState().settings.voiceModel, 'Puck');
    assert.deepEqual(patches, []);
  });
});

describe('MP-13: requests stay stoppable after headers arrive', () => {
  const stalledBody = () =>
    new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  it('a JSON call whose body stalls still times out', async () => {
    const { fetchJson, TimeoutError } = await import('../../frontend/src/services/api/http.ts');
    globalThis.fetch = async () => stalledBody();
    await assert.rejects(fetchJson('/api/usage', { timeoutMs: 60 }, 'x'), (err) => err instanceof TimeoutError);
  });

  it('Stop ends a chat stream that stalled after its headers', async () => {
    const { chatApi } = await import('../../frontend/src/services/api/chat.ts');
    let fetchSignal;
    globalThis.fetch = async (_url, init) => {
      fetchSignal = init.signal;
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    };
    const controller = new AbortController();
    let completed = false;
    const done = chatApi.streamChat('hi', [], () => {}, () => { completed = true; }, () => {}, { signal: controller.signal });
    await flush();
    controller.abort();
    await done;
    assert.equal(completed, true);
    assert.equal(fetchSignal.aborted, true, 'the request itself is cancelled, not just the UI');
  });
});

describe('MP-12 / MP-26: saved chats keep identity; sends are keyed', () => {
  it('gives legacy messages stable ids and keeps voice receipts and locked titles', () => {
    const row = {
      id: 's1',
      title: 'Renamed',
      titleLocked: true,
      createdAt: '2026-09-20T10:00:00.000Z',
      messages: [
        { role: 'user', content: 'hi' },
        { id: 'voice-vs_1', role: 'assistant', content: 'You talked', kind: 'voice_receipt', voice_used_s: 90 },
      ],
    };
    const first = normalizeCloudSession(row);
    const again = normalizeCloudSession(row);
    assert.equal(first.messages[0].id, 's1:m0');
    assert.equal(again.messages[0].id, first.messages[0].id, 'same id on every load');
    assert.equal(first.messages[1].kind, 'voice_receipt');
    assert.equal(first.messages[1].voice_used_s, 90);
    assert.equal(first.titleLocked, true);
  });

  it('each chat send carries a fresh Idempotency-Key', async () => {
    const { chatApi } = await import('../../frontend/src/services/api/chat.ts');
    const keys = [];
    globalThis.fetch = async (_url, init) => {
      keys.push(new Headers(init.headers).get('Idempotency-Key'));
      return new Response('data: [DONE]\n\n', { status: 200 });
    };
    await chatApi.streamChat('one', [], () => {}, () => {}, () => {});
    await chatApi.streamChat('two', [], () => {}, () => {}, () => {});
    assert.ok(keys[0] && keys[1] && keys[0] !== keys[1]);
  });
});

describe('pinned chats', () => {
  it('stay pinned when the next message saves the session', () => {
    useChatHistoryStore.getState().saveSession(session('p1', 'pin me'));
    useChatHistoryStore.getState().togglePinned('p1');
    // The message stream saves without knowing about pins.
    useChatHistoryStore.getState().saveSession({ ...session('p1', 'pin me'), updatedAt: '2026-09-21T10:00:00.000Z' });
    assert.equal(useChatHistoryStore.getState().sessions.find((s) => s.id === 'p1').pinned, true);
  });

  it('arrive from another device even when nothing else changed', async () => {
    signIn('usr_pin');
    useChatHistoryStore.setState({ sessions: [session('p2', 'same chat')] });
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ sessions: [{ ...session('p2', 'same chat'), pinned: true }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    await useChatHistoryStore.getState().loadCloudSessions();
    assert.equal(useChatHistoryStore.getState().sessions.find((s) => s.id === 'p2').pinned, true);
  });
});
