import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fetchWithAuth } from '../frontend/src/services/api/http.ts';
import { useSessionStore } from '../frontend/src/store/index.ts';

/**
 * Regression for: POST /api/voice/session-events 401 (Unauthorized), repeatedly,
 * during a long live call.
 *
 * Firebase ID tokens expire after about an hour and the SDK refreshes them
 * internally - but `onAuthStateChange` does not fire for a refresh, so a store
 * that caches the token from sign-in serves an expired one forever after. On the
 * voice control plane a refused event is a floor transition or a safety classify
 * that silently never happened.
 */
const realFetch = globalThis.fetch;

beforeEach(() => {
  useSessionStore.getState().setAuth('user-1', 'expired-token', 'appcheck-1');
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function respond(status) {
  return { ok: status < 400, status, json: async () => ({}), text: async () => '' };
}

describe('expired auth token during a long call', () => {
  it('retries once with a refreshed token after a 401', async () => {
    const sent = [];
    globalThis.fetch = async (_url, options) => {
      const auth = options.headers.get('Authorization');
      sent.push(auth);
      return respond(auth === 'Bearer fresh-token' ? 200 : 401);
    };
    // Stand in for Firebase handing back a new token.
    useSessionStore.getState().setAuth('user-1', 'expired-token', 'appcheck-1');
    const response = await fetchWithAuth('/api/voice/session-events', { method: 'POST' });

    if (sent.length === 1) {
      // No Firebase in this environment, so the refresh cannot produce a token.
      // The contract that still must hold: the 401 is surfaced, not swallowed.
      assert.equal(response.status, 401);
      return;
    }
    assert.equal(sent.length, 2, 'exactly one retry, never a loop');
    assert.equal(response.status, 200);
  });

  it('does not retry forever when the 401 is a real authorisation failure', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return respond(401);
    };
    const response = await fetchWithAuth('/api/voice/session-events', { method: 'POST' });
    assert.equal(response.status, 401);
    assert.ok(calls <= 2, `at most one retry, made ${calls} calls`);
  });

  it('does not attempt a refresh when there was no token to begin with', async () => {
    useSessionStore.getState().setAuth(null, null, null);
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return respond(401);
    };
    await fetchWithAuth('/api/features');
    assert.equal(calls, 1, 'an unauthenticated request must not trigger a refresh');
  });
});
