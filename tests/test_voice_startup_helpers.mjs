import test from 'node:test';
import assert from 'node:assert/strict';

import { buildVoiceKeyUrl, classifySocketClose, classifyVoiceStartupFailure, fetchVoiceKeyWithRetry } from '../frontend/js/voice/startup_helpers.mjs';

test('buildVoiceKeyUrl joins the base URL and voice key path correctly', () => {
  assert.equal(buildVoiceKeyUrl('https://example.com/api'), 'https://example.com/api/voice/key');
  assert.equal(buildVoiceKeyUrl('https://example.com/api/'), 'https://example.com/api/voice/key');
  assert.equal(buildVoiceKeyUrl(''), '/voice/key');
});

test('fetchVoiceKeyWithRetry retries once after an auth failure and succeeds', async () => {
  let attempts = 0;
  const responses = [
    { ok: false, status: 401, json: async () => ({ detail: { message: 'auth failed' } }) },
    { ok: true, status: 200, json: async () => ({ key: 'abc123' }) },
  ];

  const result = await fetchVoiceKeyWithRetry({
    baseUrl: 'https://example.com/api',
    token: 'first-token',
    refreshToken: async () => 'second-token',
    fetchImpl: async (url, init) => {
      attempts += 1;
      assert.equal(url, 'https://example.com/api/voice/key');
      if (attempts === 1) {
        assert.equal(init.headers.Authorization, 'Bearer first-token');
      } else {
        assert.equal(init.headers.Authorization, 'Bearer second-token');
      }
      return responses[attempts - 1];
    },
  });

  assert.equal(attempts, 2);
  assert.equal(result.key, 'abc123');
});

test('classifyVoiceStartupFailure detects retryable network errors', () => {
  assert.deepEqual(classifyVoiceStartupFailure({ message: 'fetch failed' }), {
    retryable: true,
    reason: 'network',
    status: null,
  });
  assert.deepEqual(classifyVoiceStartupFailure({ status: 503 }), {
    retryable: true,
    reason: 'server',
    status: 503,
  });
  assert.deepEqual(classifyVoiceStartupFailure({ status: 401 }), {
    retryable: true,
    reason: 'authentication',
    status: 401,
  });
});

test('classifySocketClose avoids stopping the session after a transient close after greeting', () => {
  assert.deepEqual(classifySocketClose({ code: 1006, wasClean: false, hasSetupComplete: true, greetingSent: true }), {
    retryable: true,
    shouldStop: false,
    reason: 'transient',
  });
  assert.deepEqual(classifySocketClose({ code: 1000, wasClean: true, hasSetupComplete: true, greetingSent: true }), {
    retryable: false,
    shouldStop: true,
    reason: 'normal',
  });
});
