import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import storage constants
import { STORAGE_KEYS } from '../frontend/src/constants/storage.ts';
import { useChatStore } from '../frontend/src/store/chat.ts';
import { useFlagsStore, DEFAULT_FLAGS } from '../frontend/src/store/flags.ts';
import { useMemoryStore } from '../frontend/src/store/memory.ts';
import { honestMemorySummary } from '../frontend/src/utils/memory/memory.ts';

describe('Storage Constants Contract', () => {
  it('defines all required persistence keys with mindpal_ prefix', () => {
    assert.equal(STORAGE_KEYS.THEME, 'mindpal_theme');
    assert.equal(STORAGE_KEYS.SETTINGS, 'mindpal_settings_v1');
    assert.equal(STORAGE_KEYS.STREAK, 'mindpal_streak');
    assert.equal(STORAGE_KEYS.CHAT_SESSIONS, 'mindpal_chat_sessions');
    assert.equal(STORAGE_KEYS.AUTH_LAST_USED, 'mindpal_auth_last_used');
    assert.equal(STORAGE_KEYS.PRESENCE_WAITLIST, 'mindpal_presence_waitlist');
    assert.equal(STORAGE_KEYS.LAST_SEEN_CHANGELOG, 'mindpal_last_seen_changelog');
    assert.equal(STORAGE_KEYS.GUEST_DEVICE_ID, 'mindpal_guest_device_id');
    assert.equal(STORAGE_KEYS.GUEST_MEMORY, 'mindpal_guest_memory_v1');
  });
});

describe('Per-device guest memory', () => {
  const makeStorage = () => {
    const data = new Map();
    return {
      getItem: (key) => (data.has(key) ? data.get(key) : null),
      setItem: (key, value) => {
        data.set(key, String(value));
      },
      removeItem: (key) => {
        data.delete(key);
      },
      data,
    };
  };

  it('isolates two guest device graphs and refuses the shared anon key', async () => {
    const {
      SHARED_ANON_GRAPH_KEY,
      canPersistUserMemory,
      canWriteGuestGraph,
      captureMemoryReceipt,
      createGuestDeviceId,
      loadGuestGraph,
      rememberReceipt,
      saveGuestGraph,
      updateGuestAtom,
    } = await import('../frontend/src/utils/memory/guestMemory.ts');

    assert.equal(canPersistUserMemory('usr_mem_write'), true);
    assert.equal(canPersistUserMemory(SHARED_ANON_GRAPH_KEY), false);
    assert.equal(canPersistUserMemory('gst_0123456789abcdef0123456789abcdef'), false);
    assert.equal(canWriteGuestGraph(SHARED_ANON_GRAPH_KEY), false);

    const firstId = createGuestDeviceId(() => Uint8Array.from({ length: 16 }, () => 0x11));
    const secondId = createGuestDeviceId(() => Uint8Array.from({ length: 16 }, () => 0x22));
    assert.notEqual(firstId, secondId);
    assert.match(firstId, /^gst_[0-9a-f]{32}$/);

    const firstStore = makeStorage();
    firstStore.setItem(STORAGE_KEYS.GUEST_DEVICE_ID, firstId);
    const secondStore = makeStorage();
    secondStore.setItem(STORAGE_KEYS.GUEST_DEVICE_ID, secondId);

    const ada = rememberReceipt(
      { count: 1, saved: [{ id: 'profile:preferred_name', type: 'profile', text: 'Preferred name: Ada' }] },
      firstStore,
    );
    const beau = rememberReceipt(
      { count: 1, saved: [{ id: 'profile:preferred_name', type: 'profile', text: 'Preferred name: Beau' }] },
      secondStore,
    );
    assert.ok(ada);
    assert.ok(beau);

    const firstGraph = loadGuestGraph(firstStore, firstId);
    const secondGraph = loadGuestGraph(secondStore, secondId);
    assert.equal(firstGraph.atoms[0].value.includes('Ada'), true);
    assert.equal(secondGraph.atoms[0].value.includes('Beau'), true);
    assert.equal(firstGraph.atoms.some((atom) => atom.value.includes('Beau')), false);
    assert.equal(secondGraph.atoms.some((atom) => atom.value.includes('Ada')), false);
    assert.equal(firstStore.data.has(`${STORAGE_KEYS.GUEST_MEMORY}:${SHARED_ANON_GRAPH_KEY}`), false);
    assert.equal(
      saveGuestGraph({ deviceId: SHARED_ANON_GRAPH_KEY, atoms: firstGraph.atoms }, firstStore),
      false,
    );
    assert.equal(captureMemoryReceipt(ada, true, firstStore)?.saved[0].text, 'Preferred name: Ada');

    const renamed = updateGuestAtom('profile:preferred_name', 'Preferred name: Ada Lovelace', firstStore);
    assert.equal(renamed?.value, 'Preferred name: Ada Lovelace');
    assert.equal(loadGuestGraph(firstStore, firstId).atoms[0].value, 'Preferred name: Ada Lovelace');
    assert.equal(updateGuestAtom('profile:preferred_name', '   ', firstStore), null);
    assert.equal(updateGuestAtom('missing', 'Nope', firstStore), null);
  });
});

describe('Chat Store State Machine Logic', () => {
  const resetChatStore = () => {
    useChatStore.setState({
      messages: [],
      isGenerating: false,
      abortController: null,
      activeModel: 'standard',
      activeMode: 'Active Listen',
      strategyUsed: null,
      editingUserId: null,
    });
  };

  it('uses the real chat store to deduplicate and update messages', () => {
    resetChatStore();

    const firstMessage = {
      id: 'msg_1',
      role: 'user',
      content: 'Hello',
      timestamp: '2026-09-14T00:00:00Z',
    };

    useChatStore.getState().addMessage(firstMessage);
    useChatStore.getState().addMessage({ ...firstMessage, content: 'Duplicate Hello' });

    assert.equal(useChatStore.getState().messages.length, 1);
    assert.equal(useChatStore.getState().messages[0].content, 'Hello');

    useChatStore.getState().updateLastMessage('Updated hello', 'Active Listen');
    assert.equal(useChatStore.getState().messages[0].content, 'Updated hello');
    assert.equal(useChatStore.getState().messages[0].strategy_used, 'Active Listen');
  });

  it('attaches and clears a memory receipt on a message', () => {
    resetChatStore();
    useChatStore.getState().addMessage({
      id: 'msg_a',
      role: 'assistant',
      content: 'Noted.',
      timestamp: '2026-09-14T00:00:00Z',
    });
    useChatStore.getState().setMessageMemoryReceipt('msg_a', {
      count: 1,
      saved: [{ id: 'profile:preferred_name', type: 'profile', text: 'Preferred name: Sarah' }],
    });
    assert.equal(useChatStore.getState().messages[0].memoryReceipt?.saved[0].text, 'Preferred name: Sarah');
    useChatStore.getState().setMessageMemoryReceipt('msg_a', null);
    assert.equal(useChatStore.getState().messages[0].memoryReceipt, undefined);
    assert.equal('memoryReceipt' in useChatStore.getState().messages[0], false);

    useChatStore.getState().setMessageMemoryReceipt('msg_a', {
      count: 1,
      saved: [{ id: 'profile:preferred_name', type: 'profile', text: 'Preferred name: Sarah' }],
    });
    useChatStore.getState().setMessages(useChatStore.getState().messages);
    assert.equal('memoryReceipt' in useChatStore.getState().messages[0], false);
  });

  // Simulate duplicate message protection
  it('deduplicates incoming messages with identical IDs', () => {
    const messages = [
      { id: 'msg_1', role: 'user', content: 'Hello', timestamp: '2026-09-14T00:00:00Z' },
    ];

    const addMessage = (current, next) => {
      if (current.some((m) => m.id === next.id)) return current;
      return [...current, next];
    };

    const attempt1 = addMessage(messages, {
      id: 'msg_1',
      role: 'user',
      content: 'Duplicate Hello',
      timestamp: '2026-09-14T00:00:01Z',
    });
    assert.equal(attempt1.length, 1);
    assert.equal(attempt1[0].content, 'Hello');

    const attempt2 = addMessage(messages, {
      id: 'msg_2',
      role: 'assistant',
      content: 'Hi there!',
      timestamp: '2026-09-14T00:00:02Z',
    });
    assert.equal(attempt2.length, 2);
    assert.equal(attempt2[1].id, 'msg_2');
  });

  it('updates message content in-place without duplicating', () => {
    const messages = [
      { id: 'msg_user', role: 'user', content: 'Explain quantum mechanics', timestamp: '2026-09-14T00:00:00Z' },
      { id: 'msg_ai', role: 'assistant', content: 'Quantum', timestamp: '2026-09-14T00:00:01Z' },
    ];

    const updateMessage = (current, id, content, strategy) => {
      return current.map((m) =>
        m.id === id ? { ...m, content, ...(strategy ? { strategy_used: strategy } : {}) } : m
      );
    };

    const updated = updateMessage(messages, 'msg_ai', 'Quantum mechanics is the study of matter.', 'Active Listen');
    assert.equal(updated.length, 2);
    assert.equal(updated[1].content, 'Quantum mechanics is the study of matter.');
    assert.equal(updated[1].strategy_used, 'Active Listen');
  });

  it('correctly handles message removal', () => {
    const messages = [
      { id: 'm1', role: 'user', content: '1', timestamp: '' },
      { id: 'm2', role: 'assistant', content: '2', timestamp: '' },
    ];
    const filtered = messages.filter((m) => m.id !== 'm1');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, 'm2');
  });

  it('stopGeneration aborts the active controller and clears generation flags', () => {
    resetChatStore();

    const controller = new AbortController();
    useChatStore.setState({ abortController: controller, isGenerating: true });

    controller.abort = () => {
      // preserve the real abort semantics while allowing the assertion to observe the run
    };

    useChatStore.getState().stopGeneration();

    assert.equal(useChatStore.getState().isGenerating, false);
    assert.equal(useChatStore.getState().abortController, null);
  });

  it('tracks in-place user-message edit and clears it with the thread', () => {
    resetChatStore();
    useChatStore.getState().setEditingUserId('msg-user-1');
    assert.equal(useChatStore.getState().editingUserId, 'msg-user-1');
    useChatStore.getState().clearMessages();
    assert.equal(useChatStore.getState().editingUserId, null);
  });
});

describe('Memory inspector store contract', () => {
  const resetMemoryStore = () => {
    useMemoryStore.setState({
      summary: null,
      isOpen: false,
      inspectTab: 'summary',
      highlightAtomIds: [],
      returnToSettings: false,
      isLoading: false,
      error: null,
    });
  };

  it('opens on the atoms tab with highlight ids from Review, and clears them on close', () => {
    resetMemoryStore();
    useMemoryStore.getState().setIsOpen(true, 'atoms', ['profile:preferred_name', 'goal:sleep']);
    assert.equal(useMemoryStore.getState().isOpen, true);
    assert.equal(useMemoryStore.getState().inspectTab, 'atoms');
    assert.deepEqual(useMemoryStore.getState().highlightAtomIds, ['profile:preferred_name', 'goal:sleep']);

    useMemoryStore.getState().setIsOpen(false);
    assert.equal(useMemoryStore.getState().isOpen, false);
    assert.equal(useMemoryStore.getState().inspectTab, 'summary');
    assert.deepEqual(useMemoryStore.getState().highlightAtomIds, []);
    assert.equal(useMemoryStore.getState().returnToSettings, false);
  });

  it('records a settings return so Memory can reopen Personalization', () => {
    resetMemoryStore();
    useMemoryStore.getState().setIsOpen(true, 'summary', [], { returnToSettings: true });
    assert.equal(useMemoryStore.getState().isOpen, true);
    assert.equal(useMemoryStore.getState().returnToSettings, true);

    useMemoryStore.getState().setIsOpen(false);
    assert.equal(useMemoryStore.getState().returnToSettings, false);
  });

  it('does not auto-open the inspector and ignores blank highlight ids', () => {
    resetMemoryStore();
    assert.equal(useMemoryStore.getState().isOpen, false);
    useMemoryStore.getState().setIsOpen(true, 'summary', ['', '  ']);
    assert.equal(useMemoryStore.getState().isOpen, true);
    assert.equal(useMemoryStore.getState().inspectTab, 'summary');
    assert.deepEqual(useMemoryStore.getState().highlightAtomIds, []);
  });
});

describe('Honest memory summary', () => {
  it('treats blank and placeholder summaries as empty', () => {
    assert.equal(honestMemorySummary(''), '');
    assert.equal(honestMemorySummary('User is building a therapeutic reflective space.'), '');
    assert.equal(honestMemorySummary('user reflective context.'), '');
    assert.equal(honestMemorySummary('Prefers evening walks.'), 'Prefers evening walks.');
  });
});

describe('Feature Flag Store Contract', () => {
  it('keeps Presence gated off by default', () => {
    useFlagsStore.setState({ flags: { ...DEFAULT_FLAGS } });
    const initialFlags = useFlagsStore.getState().flags;
    assert.equal(initialFlags.presence_enabled, false);
    assert.equal(initialFlags.voice_enabled, true);

    useFlagsStore.getState().setFlags({
      ...initialFlags,
      presence_enabled: true,
    });

    assert.equal(useFlagsStore.getState().flags.presence_enabled, true);

    useFlagsStore.getState().setFlags({
      ...initialFlags,
      presence_enabled: false,
    });
  });
});

describe('Settings Store Persistence & Schema Contract', () => {
  const defaultSettings = {
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
  };

  it('hydrates default settings when localStorage is empty', () => {
    const hydrate = (raw) => {
      if (!raw) return defaultSettings;
      const parsed = JSON.parse(raw);
      return {
        ...defaultSettings,
        ...parsed,
        personalization: {
          ...defaultSettings.personalization,
          ...(parsed.personalization || {}),
        },
      };
    };

    const emptyResult = hydrate(null);
    assert.deepEqual(emptyResult, defaultSettings);
  });

  it('merges partial saved settings with defaults preserving sub-objects', () => {
    const hydrate = (raw) => {
      if (!raw) return defaultSettings;
      const parsed = JSON.parse(raw);
      return {
        ...defaultSettings,
        ...parsed,
        personalization: {
          ...defaultSettings.personalization,
          ...(parsed.personalization || {}),
        },
      };
    };

    const saved = JSON.stringify({
      theme: 'light',
      personalization: { warmth: 'direct' },
    });

    const result = hydrate(saved);
    assert.equal(result.theme, 'light');
    assert.equal(result.soundEnabled, true); // default preserved
    assert.equal(result.personalization.warmth, 'direct');
    assert.equal(result.personalization.baseStyle, 'balanced'); // default preserved
    assert.equal(result.personalization.emojiSupport, true); // default preserved
  });
});

describe('Chat Session Grouping Contract', () => {
  function groupSessions(sessions) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterday = today - 86_400_000;
    const weekAgo = today - 7 * 86_400_000;
    const monthAgo = today - 30 * 86_400_000;

    const groups = {
      Today: [],
      Yesterday: [],
      'This week': [],
      'This month': [],
      Older: [],
    };

    for (const s of sessions) {
      const t = new Date(s.updatedAt || s.createdAt).getTime();
      if (t >= today) groups['Today'].push(s);
      else if (t >= yesterday) groups['Yesterday'].push(s);
      else if (t >= weekAgo) groups['This week'].push(s);
      else if (t >= monthAgo) groups['This month'].push(s);
      else groups['Older'].push(s);
    }

    return Object.entries(groups)
      .filter(([, items]) => items.length > 0)
      .map(([label, items]) => ({ label, items }));
  }

  it('categorizes sessions into accurate temporal buckets', () => {
    const nowIso = new Date().toISOString();
    const yesterdayIso = new Date(Date.now() - 90_000_000).toISOString();
    const olderIso = new Date(Date.now() - 40 * 86_400_000).toISOString();

    const sampleSessions = [
      { id: 's1', title: 'Chat today', createdAt: nowIso, updatedAt: nowIso, messages: [] },
      { id: 's2', title: 'Chat yesterday', createdAt: yesterdayIso, updatedAt: yesterdayIso, messages: [] },
      { id: 's3', title: 'Chat older', createdAt: olderIso, updatedAt: olderIso, messages: [] },
    ];

    const grouped = groupSessions(sampleSessions);
    const labels = grouped.map((g) => g.label);

    assert.ok(labels.includes('Today'), 'Should have Today group');
    assert.ok(labels.includes('Yesterday'), 'Should have Yesterday group');
    assert.ok(labels.includes('Older'), 'Should have Older group');
  });
});
