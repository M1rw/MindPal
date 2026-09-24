import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TIMEOUT_MS,
  TimeoutError,
  fetchJson,
  fetchWithAuth,
} from '../../frontend/src/services/api/http.ts';
import {
  CONTROL_EVENT_TIMEOUT_MS,
  CONTROL_MINT_TIMEOUT_MS,
  CONTROL_UNREACHABLE_COOLDOWN_MS,
  CONTROL_UNREACHABLE_STRIKES,
  ControlPlaneClient,
  normalizeControlAction,
} from '../../frontend/src/voice/control/controlPlane.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A fetch that never settles unless its signal aborts — a stalled connection. */
function hangingFetch(record) {
  return (url, options) => {
    if (record) {
      record.url = url;
      record.signal = options?.signal;
    }
    return new Promise((_resolve, reject) => {
      const signal = options?.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(signal.reason ?? new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
    });
  };
}

function jsonFetch(body, record) {
  return (url, options) => {
    if (record) {
      record.url = url;
      record.body = options?.body;
      record.signal = options?.signal;
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
  };
}

describe('http transport ceilings', () => {
  it('aborts a stalled request instead of hanging forever', async () => {
    globalThis.fetch = hangingFetch();
    const started = Date.now();
    await assert.rejects(
      fetchWithAuth('/api/voice/session-events', { method: 'POST', timeoutMs: 120 }),
      (error) => error instanceof TimeoutError,
      'a stalled fetch must surface as a TimeoutError',
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `should abort promptly, took ${elapsed}ms`);
  });

  it('applies a default ceiling so a caller cannot forget one', () => {
    assert.ok(DEFAULT_TIMEOUT_MS > 0, 'there must be a default ceiling');
    assert.ok(DEFAULT_TIMEOUT_MS <= 30_000, 'the default must be a real bound');
  });

  it('passes an abort signal on every request', async () => {
    const record = {};
    globalThis.fetch = jsonFetch({ ok: true }, record);
    await fetchJson('/api/voice/session-events', { method: 'POST' }, 'failed');
    assert.ok(record.signal, 'requests must carry a signal the timeout can fire on');
    assert.equal(record.signal.aborted, false);
  });

  it('honours an explicit opt-out for long-lived requests', async () => {
    const record = {};
    globalThis.fetch = jsonFetch({ ok: true }, record);
    await fetchJson('/api/chat', { method: 'POST', timeoutMs: 0 }, 'failed');
    assert.ok(record.signal, 'a signal is still supplied');
  });
});

describe('control plane budgets', () => {
  it('gives live-voice events a tighter ceiling than a normal call', () => {
    assert.ok(
      CONTROL_EVENT_TIMEOUT_MS < DEFAULT_TIMEOUT_MS,
      'events gate the microphone, so they must fail faster than the generic default',
    );
    assert.ok(CONTROL_EVENT_TIMEOUT_MS >= 5_000, 'but must still allow a real classify round trip');
    assert.ok(CONTROL_MINT_TIMEOUT_MS >= CONTROL_EVENT_TIMEOUT_MS, 'a handshake may take longer');
  });

  it('reports a stalled control plane as unverified, never as continue', async () => {
    globalThis.fetch = hangingFetch();
    const client = new ControlPlaneClient('sess-1');
    const result = await client.syncTranscripts('I am not okay', '', { isFinal: true });
    assert.equal(result.action, 'safety_unverified');
    assert.notEqual(result.action, 'continue', 'a timeout must never read as an all-clear');
  });

  it('still normalises a legacy crisis_freeze into escalate_pause', () => {
    assert.equal(normalizeControlAction({ ok: true, action: 'crisis_freeze' }).action, 'escalate_pause');
    assert.equal(normalizeControlAction(null).action, 'safety_unverified');
  });
});

/** A fetch that refuses to connect at all, the way a dead backend does. */
function refusedFetch(record) {
  return () => {
    if (record) record.calls += 1;
    return Promise.reject(new TypeError('Failed to fetch'));
  };
}

describe('a backend that is not there', () => {
  it('stops dialling after a few refusals instead of once per event', async () => {
    const record = { calls: 0 };
    globalThis.fetch = refusedFetch(record);
    const client = new ControlPlaneClient('sess-down');
    for (let i = 0; i < 12; i += 1) {
      const result = await client.syncTranscripts('still talking', '');
      assert.equal(result.action, 'safety_unverified', 'a call that never landed is never an all-clear');
    }
    assert.equal(
      record.calls,
      CONTROL_UNREACHABLE_STRIKES,
      'a refused connection logs one line per cooldown, not one per event',
    );
    assert.equal(client.unreachable, true);
  });

  it('keeps asking a server that answers badly', async () => {
    // A 500 is a server having a bad minute. Backing off from it would stop
    // classifying transcripts on a backend that is still there to answer.
    const record = { calls: 0 };
    globalThis.fetch = () => {
      record.calls += 1;
      return Promise.resolve({
        ok: false,
        status: 500,
        json: async () => ({ detail: 'boom' }),
        text: async () => '{"detail":"boom"}',
      });
    };
    const client = new ControlPlaneClient('sess-sick');
    for (let i = 0; i < 6; i += 1) {
      const result = await client.syncTranscripts('still talking', '');
      assert.equal(result.action, 'safety_unverified');
    }
    assert.equal(record.calls, 6, 'every event still reaches a server that is answering');
    assert.equal(client.unreachable, false);
  });

  it('comes back the moment the backend answers again', async () => {
    globalThis.fetch = refusedFetch();
    let clock = 1_000;
    const client = new ControlPlaneClient('sess-recover', undefined, () => clock);
    for (let i = 0; i < CONTROL_UNREACHABLE_STRIKES; i += 1) {
      await client.syncTranscripts('hello', '');
    }
    assert.equal(client.unreachable, true);
    clock += CONTROL_UNREACHABLE_COOLDOWN_MS + 1;
    assert.equal(client.unreachable, false, 'the cooldown expires on its own');
    globalThis.fetch = jsonFetch({ ok: true, action: 'continue', safety_verified: true });
    const result = await client.syncTranscripts('hello', '');
    assert.equal(result.action, 'continue');
    assert.equal(client.unreachable, false, 'one good answer clears the circuit');
  });
});

describe('a session the server has never heard of', () => {
  it('stops asking after a 404 instead of refusing the rest of the call', async () => {
    // A backend restart mid-call leaves the provider socket up and every event
    // 404ing. One trace carried 60 identical refusals across the last 280
    // seconds of a live call.
    const record = { calls: 0 };
    globalThis.fetch = () => {
      record.calls += 1;
      return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({ code: 'not_found', detail: 'That live voice session is not available.' }),
        text: async () => '{"code":"not_found"}',
      });
    };
    const client = new ControlPlaneClient('sess-gone');
    for (let i = 0; i < 10; i += 1) {
      const result = await client.syncTranscripts('still talking', '');
      assert.equal(result.action, 'safety_unverified', 'a session that does not exist is never verified');
    }
    assert.equal(record.calls, 1, 'one 404 is the whole answer');
    assert.equal(client.sessionMissing, true);
  });

  it('keeps a missing session missing, unlike an unreachable one', async () => {
    globalThis.fetch = () => Promise.resolve({
      ok: false,
      status: 404,
      json: async () => ({ code: 'not_found' }),
      text: async () => '{}',
    });
    let clock = 1_000;
    const client = new ControlPlaneClient('sess-gone-2', undefined, () => clock);
    await client.syncTranscripts('hello', '');
    clock += CONTROL_UNREACHABLE_COOLDOWN_MS * 10;
    assert.equal(client.unreachable, true, 'no cooldown brings back a session that was deleted');
  });
});

describe('renew survives a storage blip', () => {
  const GRANT = { token: 'auth_tokens/real', ws_url: 'wss://x/live', expires_at: '2099-01-01T00:00:00Z' };
  const respond = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  it('retries a 503 twice, then succeeds, instead of ending the call', async () => {
    const statuses = [503, 503, 200];
    let calls = 0;
    globalThis.fetch = async () => {
      const status = statuses[calls++];
      return status === 200 ? respond(200, GRANT) : respond(503, { error: { code: 'unavailable', message: 'busy' } });
    };
    const grant = await new ControlPlaneClient('vs_1').renew();
    assert.equal(grant.token, GRANT.token);
    assert.equal(calls, 3);
  });

  it('does not retry a refusal that will not change (4xx)', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return respond(429, { error: { code: 'quota_exceeded', message: 'used up' } });
    };
    await assert.rejects(new ControlPlaneClient('vs_1').renew());
    assert.equal(calls, 1);
  });
});
