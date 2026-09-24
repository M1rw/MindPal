import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { useSettingsStore } from '../../frontend/src/store/settings.ts';
import { resetOwnerForTests } from '../../frontend/src/services/session/owner.ts';
import { handOver } from '../../frontend/src/services/session/handover.ts';

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
  resetOwnerForTests();
  useSettingsStore.getState().resetSettings();
});

describe('settings and the account that owns the browser', () => {
  it("an account's preferences leave with it on sign-out; the theme stays", () => {
    handOver('usr_a');
    useSettingsStore.getState().updateSettings({
      theme: 'light',
      personalization: { baseStyle: 'concise', warmth: 'direct' },
      quickActions: ['theme'],
      skipConfirm: { 'new-chat': true },
    });
    handOver(null);
    const after = useSettingsStore.getState().settings;
    assert.equal(after.personalization.baseStyle, 'balanced');
    assert.equal(after.personalization.warmth, 'warm');
    assert.deepEqual(after.quickActions, ['new-chat', 'live-voice', 'memory', 'settings']);
    assert.equal(after.skipConfirm['new-chat'], undefined);
    assert.equal(after.theme, 'light');
  });

  it("a guest's choices carry into the account they sign in to", () => {
    useSettingsStore.getState().updateSettings({ personalization: { baseStyle: 'detailed' } });
    handOver('usr_b');
    assert.equal(useSettingsStore.getState().settings.personalization.baseStyle, 'detailed');
  });
});
