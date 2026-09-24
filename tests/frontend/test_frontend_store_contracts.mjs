import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { STORAGE_KEYS } from '../../frontend/src/constants/storage.ts';
import { useChatStore } from '../../frontend/src/store/chat.ts';
import { useChatHistoryStore } from '../../frontend/src/store/history.ts';
import { useSessionStore } from '../../frontend/src/store/session.ts';
import { useSettingsStore } from '../../frontend/src/store/settings.ts';
import { useFlagsStore, DEFAULT_FLAGS } from '../../frontend/src/store/flags.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const createMockLocalStorage = () => {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
};

beforeEach(() => {
  globalThis.window = globalThis;
  globalThis.window.location = { hostname: 'localhost' };
  globalThis.localStorage = createMockLocalStorage();

  useSessionStore.setState({
    userId: null,
    idToken: null,
    appCheckToken: null,
    isAuthenticated: false,
  });

  useChatStore.setState({
    messages: [],
    isGenerating: false,
    abortController: null,
    activeModel: 'standard',
    activeMode: 'Active Listen',
    strategyUsed: null,
    composerDraft: null,
    editingUserId: null,
  });

  useChatHistoryStore.setState({
    sessions: [],
    activeSessionId: null,
    isLoadingCloud: false,
    cloudError: null,
  });

  useSettingsStore.setState({
    settings: {
      theme: 'dark',
      soundEnabled: true,
      voiceModel: 'advanced',
      voiceLanguage: 'auto',
      personalization: {
        baseStyle: 'balanced',
        warmth: 'warm',
        useHeadersLists: true,
        emojiSupport: true,
      },
    },
    isOpen: false,
    activeTab: 'general',
  });

  useFlagsStore.setState({
    flags: {
      voice_enabled: true,
      presence_enabled: true,
      pro_model_enabled: true,
      memory_enabled: true,
      changelog_enabled: true,
    },
  });
});

describe('Session store auth lifecycle contract', () => {
  it('stores auth metadata and clears it cleanly', () => {
    useSessionStore.getState().setAuth('user-1', 'token-1', 'appcheck-1');

    assert.equal(useSessionStore.getState().userId, 'user-1');
    assert.equal(useSessionStore.getState().idToken, 'token-1');
    assert.equal(useSessionStore.getState().appCheckToken, 'appcheck-1');
    assert.equal(useSessionStore.getState().isAuthenticated, true);

    useSessionStore.getState().clearAuth();

    assert.equal(useSessionStore.getState().userId, null);
    assert.equal(useSessionStore.getState().idToken, null);
    assert.equal(useSessionStore.getState().appCheckToken, null);
    assert.equal(useSessionStore.getState().isAuthenticated, false);
  });
});

describe('Feature flag store contract', () => {
  it('defaults live voice on', () => {
    assert.equal(DEFAULT_FLAGS.voice_enabled, true);
  });

  it('keeps voice and presence enabled in the full-feature test profile', () => {
    const flags = useFlagsStore.getState().flags;

    assert.equal(flags.voice_enabled, true);
    assert.equal(flags.presence_enabled, true);
  });
});

describe('Chat store runtime contract', () => {
  it('deduplicates messages and updates the latest streamed message in-place', () => {
    const firstMessage = {
      id: 'msg-1',
      role: 'user',
      content: 'Hello',
      timestamp: '2026-09-14T00:00:00.000Z',
    };

    useChatStore.getState().addMessage(firstMessage);
    useChatStore.getState().addMessage(firstMessage);

    assert.equal(useChatStore.getState().messages.length, 1);

    useChatStore.getState().updateLastMessage('Hello from the assistant', 'Active Listen');

    assert.equal(useChatStore.getState().messages[0].content, 'Hello from the assistant');
    assert.equal(useChatStore.getState().messages[0].strategy_used, 'Active Listen');
  });

  it('stopGeneration aborts the active controller and clears generation flags', () => {
    const controller = new AbortController();
    useChatStore.setState({ abortController: controller, isGenerating: true });

    useChatStore.getState().stopGeneration();

    assert.equal(controller.signal.aborted, true);
    assert.equal(useChatStore.getState().isGenerating, false);
    assert.equal(useChatStore.getState().abortController, null);
  });

  it('tracks in-place user-message edit and clears it with the thread', () => {
    useChatStore.getState().setEditingUserId('msg-user-1');
    assert.equal(useChatStore.getState().editingUserId, 'msg-user-1');

    useChatStore.getState().setEditingUserId(null);
    assert.equal(useChatStore.getState().editingUserId, null);

    useChatStore.getState().setEditingUserId('msg-user-1');
    useChatStore.getState().clearMessages();
    assert.equal(useChatStore.getState().editingUserId, null);
  });
});

describe('Settings store persistence contract', () => {
  it('persists partial updates while keeping defaults for untouched fields', () => {
    useSettingsStore.getState().updateSettings({
      theme: 'light',
      personalization: {
        warmth: 'direct',
      },
    });

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.SETTINGS));

    assert.equal(saved.theme, 'light');
    assert.equal(saved.soundEnabled, true);
    assert.equal(saved.voiceModel, 'advanced');
    assert.equal(saved.voiceLanguage, 'auto');
    assert.equal(saved.personalization.baseStyle, 'balanced');
    assert.equal(saved.personalization.warmth, 'direct');
    assert.equal(saved.personalization.useHeadersLists, true);
    assert.equal(saved.personalization.emojiSupport, true);
  });
});

describe('Chat history store persistence contract', () => {
  it('stores sessions locally and tracks the active session id', () => {
    const session = {
      id: 'session-1',
      title: 'Example session',
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z',
      messages: [],
    };

    useChatHistoryStore.getState().saveSession(session);

    const storedSessions = JSON.parse(localStorage.getItem(STORAGE_KEYS.CHAT_SESSIONS));

    assert.equal(storedSessions.length, 1);
    assert.equal(storedSessions[0].id, 'session-1');
    assert.equal(useChatHistoryStore.getState().activeSessionId, 'session-1');
  });

  it('ensures an active chat session id without forking a saved history row', () => {
    useChatHistoryStore.setState({ sessions: [], activeSessionId: null });
    const first = useChatHistoryStore.getState().ensureActiveSessionId();
    const second = useChatHistoryStore.getState().ensureActiveSessionId();
    assert.equal(typeof first, 'string');
    assert.match(first, /^sess_/);
    assert.equal(first, second);
    assert.equal(useChatHistoryStore.getState().activeSessionId, first);
    assert.equal(useChatHistoryStore.getState().sessions.length, 0);
  });

  it('surfaces cloud loading failures while preserving local history', async () => {
    const localSession = {
      id: 'local-session',
      title: 'Local session',
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z',
      messages: [],
    };
    // History is loaded for the account that owns the browser, not for "any token".
    const { setOwner } = await import('../../frontend/src/services/session/owner.ts');
    setOwner('usr_cloud_test');
    useChatHistoryStore.setState({ sessions: [localSession], owner: 'usr_cloud_test' });
    useSessionStore.setState({ isAuthenticated: true, idToken: 'token' });
    globalThis.fetch = async () => {
      throw new Error('offline');
    };
    const originalWarn = console.warn;
    console.warn = () => {};

    try {
      await useChatHistoryStore.getState().loadCloudSessions();
    } finally {
      console.warn = originalWarn;
      setOwner(null);
    }
    const leftOver = useChatHistoryStore.getState();

    assert.equal(useChatHistoryStore.getState().isLoadingCloud, false);
    assert.match(useChatHistoryStore.getState().cloudError, /Could not sync cloud history/);
    assert.equal(leftOver.sessions[0].id, 'local-session');
    useChatHistoryStore.setState({ owner: 'guest' });
  });
});

describe('Chat session timestamp contract', () => {
  it('bumps activity only when messages change, not when a session is reopened', async () => {
    const { shouldBumpSessionTimestamp } = await import('../../frontend/src/utils/chat/sessionHistory.ts');
    const messages = [
      { id: 'u1', role: 'user', content: 'hello' },
      { id: 'a1', role: 'assistant', content: 'hi' },
    ];

    assert.equal(shouldBumpSessionTimestamp(undefined, messages), true);
    assert.equal(shouldBumpSessionTimestamp(messages, messages), false);
    assert.equal(
      shouldBumpSessionTimestamp(messages, [...messages, { id: 'u2', role: 'user', content: 'again' }]),
      true
    );
    assert.equal(
      shouldBumpSessionTimestamp(messages, [
        { id: 'u1', role: 'user', content: 'hello' },
        { id: 'a1', role: 'assistant', content: 'hi there' },
      ]),
      true
    );
  });

  it('derives short ChatGPT-style titles instead of dumping the first message', async () => {
    const { deriveSessionTitle } = await import('../../frontend/src/utils/chat/sessionHistory.ts');
    assert.equal(deriveSessionTitle("I'm feeling anxious"), 'Feeling anxious');
    assert.equal(deriveSessionTitle('I feel overwhelmed'), 'Feeling overwhelmed');
    assert.equal(deriveSessionTitle('I feel stuck'), 'Feeling stuck');
    assert.equal(deriveSessionTitle('Hello, my bad. How are you bro? Hope you are doing good.'), 'Checking in');
    assert.match(deriveSessionTitle('Can you help me with panic at night'), /panic at night/i);
  });

  it('formats call duration and seeds live voice from the open text thread', async () => {
    const { formatCallDuration, threadContinuation } = await import(
      '../../frontend/src/utils/chat/sessionHistory.ts'
    );
    assert.equal(formatCallDuration(0), '');
    assert.equal(formatCallDuration(25), '25s');
    assert.equal(formatCallDuration(65), '1m 5s');
    assert.equal(formatCallDuration(120), '2m');
    const note = threadContinuation([
      {
        id: 'u1',
        role: 'user',
        content: 'I have been tired at work',
        timestamp: '2026-09-15T00:00:00.000Z',
      },
      {
        id: 'a1',
        role: 'assistant',
        content: 'That sounds heavy.',
        timestamp: '2026-09-15T00:00:01.000Z',
      },
      {
        id: 'v1',
        role: 'assistant',
        kind: 'voice_receipt',
        content: 'ignored recap',
        timestamp: '2026-09-15T00:00:02.000Z',
      },
    ]);
    assert.match(note, /same MindPal conversation/);
    assert.match(note, /tired at work/);
    assert.match(note, /That sounds heavy/);
    assert.doesNotMatch(note, /ignored recap/);
    assert.equal(threadContinuation([]), '');
  });
});

describe('Chat memory receipt persistence contract', () => {
  it('strips memoryReceipt from saved sessions, loaded threads, and fingerprints', async () => {
    const {
      withoutMemoryReceipts,
      withoutSessionMemoryReceipts,
      shouldBumpSessionTimestamp,
    } = await import('../../frontend/src/utils/chat/sessionHistory.ts');

    const receipt = {
      count: 1,
      saved: [{ id: 'profile:preferred_name', type: 'profile', text: 'Preferred name: marwan' }],
    };
    const messages = [
      {
        id: 'u1',
        role: 'user',
        content: 'call me marwan',
        timestamp: '2026-09-15T00:00:00.000Z',
      },
      {
        id: 'a1',
        role: 'assistant',
        content: 'Noted.',
        timestamp: '2026-09-15T00:00:01.000Z',
        memoryReceipt: receipt,
      },
    ];

    const stripped = withoutMemoryReceipts(messages);
    assert.equal('memoryReceipt' in stripped[1], false);
    assert.equal(stripped[1].content, 'Noted.');
    assert.equal(shouldBumpSessionTimestamp(stripped, messages), false);

    const session = withoutSessionMemoryReceipts({
      id: 'session-receipt',
      title: 'Call me marwan',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:01.000Z',
      messages,
    });
    assert.equal('memoryReceipt' in session.messages[1], false);

    useChatHistoryStore.getState().saveSession({
      id: 'session-receipt',
      title: 'Call me marwan',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:01.000Z',
      messages,
    });

    const storedSessions = JSON.parse(localStorage.getItem(STORAGE_KEYS.CHAT_SESSIONS));
    assert.equal('memoryReceipt' in storedSessions[0].messages[1], false);
    assert.equal('memoryReceipt' in useChatHistoryStore.getState().sessions[0].messages[1], false);

    useChatStore.getState().setMessages(messages);
    assert.equal('memoryReceipt' in useChatStore.getState().messages[1], false);
  });
});

