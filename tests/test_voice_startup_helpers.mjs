import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEphemeralVoiceWebSocketUrl,
  buildVoiceTokenUrl,
  classifySocketClose,
  classifyVoiceStartupFailure,
  fetchVoiceTokenWithRetry,
} from '../frontend/js/voice/startup_helpers.mjs';

test('buildVoiceTokenUrl normalizes API origins', () => {
  assert.equal(buildVoiceTokenUrl('https://example.com/api'), 'https://example.com/api/voice/token');
  assert.equal(buildVoiceTokenUrl('https://example.com/api/'), 'https://example.com/api/voice/token');
  assert.equal(buildVoiceTokenUrl(''), '/voice/token');
});

test('buildEphemeralVoiceWebSocketUrl never uses a permanent API key parameter', () => {
  const url = buildEphemeralVoiceWebSocketUrl({
    token: 'short-lived-token',
    websocket_url: 'wss://example.com/BidiGenerateContentConstrained',
  });
  assert.equal(url, 'wss://example.com/BidiGenerateContentConstrained?access_token=short-lived-token');
  assert.equal(url.includes('?key='), false);
});

test('fetchVoiceTokenWithRetry refreshes Firebase auth after 401 and succeeds', async () => {
  const calls = [];
  let attempt = 0;
  const result = await fetchVoiceTokenWithRetry({
    baseUrl: 'https://example.com/api',
    token: 'expired',
    refreshToken: async () => 'fresh',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      attempt += 1;
      if (attempt === 1) return { ok: false, status: 401 };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          token: 'ephemeral',
          model: 'gemini-3.1-flash-live-preview',
          websocket_url: 'wss://example.com/live',
          expires_at: '2026-07-10T18:30:00Z',
          new_session_expires_at: '2026-07-10T18:01:00Z',
        }),
      };
    },
  });

  assert.equal(result.token, 'ephemeral');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://example.com/api/voice/token');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer expired');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer fresh');
  assert.equal(calls[1].options.cache, 'no-store');
});

test('fetchVoiceTokenWithRetry rejects incomplete responses', async () => {
  await assert.rejects(
    fetchVoiceTokenWithRetry({
      baseUrl: '',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ token: 'only-token' }) }),
      maxAttempts: 1,
    }),
    /incomplete/i,
  );
});

test('socket close classification retries transient established-session closes', () => {
  assert.equal(classifySocketClose({ code: 1006, wasClean: false, hasSetupComplete: true, greetingSent: true }).retryable, true);
  assert.equal(classifySocketClose({ code: 1000, wasClean: true, hasSetupComplete: true, greetingSent: true }).retryable, false);
});

test('startup classification treats retired key endpoint as a hard upgrade failure', () => {
  const result = classifyVoiceStartupFailure({ status: 410 });
  assert.equal(result.retryable, false);
  assert.equal(result.reason, 'client-upgrade-required');
});
