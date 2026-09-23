import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { accountStatus } from '../../frontend/src/hooks/session/useAccountStatus.ts';
import { parseUsage, syncUsage } from '../../frontend/src/services/api/chat.ts';
import { useUsageStore } from '../../frontend/src/store/index.ts';

/**
 * Regression for: a signed-in user saw the live-voice guest gate. Two stores
 * answered "signed in?" differently (Firebase user vs cached token), and when
 * sign-in was not configured at all the gate still offered a sign-in button.
 */
describe('account status', () => {
  const base = { firebaseConfigured: true, isLoading: false, hasUser: false, hasToken: false };

  it('a Firebase user is signed in even before a token lands', () => {
    assert.equal(accountStatus({ ...base, hasUser: true }), 'signed-in');
  });

  it('is loading, not guest, until Firebase reports', () => {
    assert.equal(accountStatus({ ...base, isLoading: true }), 'loading');
  });

  it('is unavailable when sign-in is not configured, so no dead sign-in button', () => {
    assert.equal(accountStatus({ ...base, firebaseConfigured: false }), 'unavailable');
  });

  it('is guest only once Firebase has said there is no user', () => {
    assert.equal(accountStatus(base), 'guest');
  });
});

describe('usage snapshot', () => {
  afterEach(() => useUsageStore.getState().clearQuota());

  it('maps the server windows without inventing limits', () => {
    const quota = parseUsage({
      credits_5h: 3, limit_5h: 40, reset_5h_seconds: 60,
      credits_week: 9, limit_week: 300, reset_week_seconds: 600, scope: 'account',
    });
    assert.equal(quota.credits_5h, 3);
    assert.equal(quota.limit_5h, 40);
    assert.equal(quota.limit_week, 300);
    assert.equal(quota.scope, 'account');
  });

  it('rejects a snapshot without a 5-hour limit instead of guessing 50', () => {
    assert.equal(parseUsage({ credits_5h: 3 }), null);
    assert.equal(parseUsage(null), null);
    syncUsage({ credits_5h: 3 });
    assert.equal(useUsageStore.getState().quota, null);
  });

  it('keeps the per-network scope for signed-out chat', () => {
    syncUsage({ credits_5h: 1, limit_5h: 10, scope: 'network' });
    assert.equal(useUsageStore.getState().quota.scope, 'network');
  });
});

describe('settings follow the account', async () => {
  const { toProfileSettings, fromProfileSettings } = await import('../../frontend/src/services/sync/settingsSync.ts');

  const settings = {
    theme: 'dark', soundEnabled: true, voiceModel: 'Sulafat', voiceLanguage: 'auto',
    personalization: { baseStyle: 'concise', warmth: 'direct', useHeadersLists: false, emojiSupport: true },
  };

  it('flattens to scalars the profile endpoint accepts, and round-trips', () => {
    const flat = toProfileSettings(settings);
    assert.ok(Object.values(flat).every((v) => ['string', 'boolean', 'number'].includes(typeof v)));
    assert.deepEqual(fromProfileSettings(flat), settings);
  });

  it('applies only known keys with allowed values', () => {
    const partial = fromProfileSettings({
      theme: 'neon', language: 'en', 'personalization.warmth': 'warm', 'personalization.baseStyle': 7,
    });
    assert.deepEqual(partial, { personalization: { warmth: 'warm' } });
  });

  it('ignores an empty or missing profile map so device settings stand', () => {
    assert.equal(fromProfileSettings({}), null);
    assert.equal(fromProfileSettings(undefined), null);
  });
});
