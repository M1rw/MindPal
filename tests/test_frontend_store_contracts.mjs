import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { STORAGE_KEYS } from '../frontend/src/constants/storage.ts';
import { useChatStore } from '../frontend/src/store/chat.ts';
import { useChatHistoryStore } from '../frontend/src/store/history.ts';
import { useSessionStore } from '../frontend/src/store/session.ts';
import { useSettingsStore } from '../frontend/src/store/settings.ts';
import { useFlagsStore } from '../frontend/src/store/flags.ts';

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
      voice_enabled: false,
      presence_enabled: false,
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
  it('keeps voice and presence disabled until explicitly enabled', () => {
    const flags = useFlagsStore.getState().flags;

    assert.equal(flags.voice_enabled, false);
    assert.equal(flags.presence_enabled, false);
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

  it('surfaces cloud loading failures while preserving local history', async () => {
    const localSession = {
      id: 'local-session',
      title: 'Local session',
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z',
      messages: [],
    };
    useChatHistoryStore.setState({ sessions: [localSession] });
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
    }

    assert.equal(useChatHistoryStore.getState().isLoadingCloud, false);
    assert.match(useChatHistoryStore.getState().cloudError, /Could not sync cloud history/);
    assert.equal(useChatHistoryStore.getState().sessions[0].id, 'local-session');
  });
});
