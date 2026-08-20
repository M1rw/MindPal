import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEphemeralVoiceWebSocketUrl,
  buildVoiceTokenUrl,
  classifySocketClose,
  classifyVoiceStartupFailure,
  fetchVoiceTokenWithRetry,
  parseVoiceRetryAfterMs,
} from '../frontend/js/voice/startup_helpers.mjs';
import {
  MAX_TRANSIENT_RECONNECT_ATTEMPTS,
  planVoiceRecovery,
} from '../frontend/js/voice/recovery_policy.js';
import {
  VOICE_MAX_CALL_MS,
  VOICE_MAX_CALL_WARNING_MS,
  VOICE_USER_INACTIVITY_END_MS,
  VOICE_USER_INACTIVITY_WARNING_MS,
  getVoiceSessionLifecycleAction,
} from '../frontend/js/voice/session_policy.js';

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

test('token 429 honors Retry-After and never multiplies a credential request', async () => {
  let calls = 0;
  await assert.rejects(
    fetchVoiceTokenWithRetry({
      baseUrl: 'https://example.com/api',
      maxAttempts: 3,
      fetchImpl: async () => {
        calls += 1;
        return {
          ok: false,
          status: 429,
          headers: { get: (name) => name === 'Retry-After' ? '125' : null },
        };
      },
    }),
    (error) => {
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 125_000);
      return true;
    },
  );
  assert.equal(calls, 1, 'a 429 must not fan out into helper retries');
});

test('parseVoiceRetryAfterMs accepts both delta-seconds and an HTTP date', () => {
  assert.equal(parseVoiceRetryAfterMs({ headers: { get: () => '7' } }), 7_000);
  assert.equal(
    parseVoiceRetryAfterMs({ headers: { get: () => 'Wed, 21 Oct 2015 07:28:00 GMT' } }, Date.parse('Wed, 21 Oct 2015 07:27:00 GMT')),
    60_000,
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


test('fetchVoiceTokenWithRetry sends and refreshes Firebase App Check with auth', async () => {
  const calls = [];
  let attempt = 0;
  const result = await fetchVoiceTokenWithRetry({
    baseUrl: 'https://example.com/api',
    token: 'expired-id-token',
    appCheckToken: 'expired-app-check',
    refreshToken: async () => 'fresh-id-token',
    refreshAppCheckToken: async () => 'fresh-app-check',
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
  assert.equal(calls[0].options.headers.Authorization, 'Bearer expired-id-token');
  assert.equal(calls[0].options.headers['X-Firebase-AppCheck'], 'expired-app-check');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer fresh-id-token');
  assert.equal(calls[1].options.headers['X-Firebase-AppCheck'], 'fresh-app-check');
});


test('provider GoAway uses a separate one-handle resumption attempt', () => {
  const recovery = planVoiceRecovery({
    reason: 'server-go-away',
    resumeRequested: true,
    hasResumptionHandle: true,
    resumptionAttempts: 0,
    transientAttempts: 3,
    recoveryCycles: 0,
  });

  assert.equal(recovery.action, 'resume');
  assert.equal(recovery.reason, 'provider-resumption');
  assert.equal(recovery.next.resumptionAttempts, 1);
  assert.equal(recovery.next.transientAttempts, 3);
});

test('a failed or unavailable resume handle transitions to fresh continuity reseed', () => {
  const recovery = planVoiceRecovery({
    reason: 'reconnect-setup-failed',
    resumeRequested: true,
    hasResumptionHandle: true,
    resumptionAttempts: 1,
  });

  assert.equal(recovery.action, 'reseed');
  assert.equal(recovery.reason, 'resume-fallback');
});

test('transient network retries pause rather than automatically end a live call', () => {
  const recovery = planVoiceRecovery({
    reason: 'transient-network',
    transientAttempts: MAX_TRANSIENT_RECONNECT_ATTEMPTS,
    recoveryCycles: 0,
  });

  assert.equal(recovery.action, 'pause');
  assert.equal(recovery.reason, 'network-recovery-pause');
  assert.equal(recovery.next.transientAttempts, 0);
  assert.equal(recovery.next.recoveryCycles, 1);
});

test('credential rate limiting pauses at the server delay without consuming resumption state', () => {
  const recovery = planVoiceRecovery({
    reason: 'credential-rate-limited',
    rateLimitRetryAfterMs: 125_000,
    resumptionAttempts: 1,
    transientAttempts: 3,
    recoveryCycles: 2,
  });

  assert.equal(recovery.action, 'pause');
  assert.equal(recovery.reason, 'credential-rate-limit');
  assert.equal(recovery.delayMs, 125_000);
  assert.equal(recovery.next.resumptionAttempts, 1);
  assert.equal(recovery.next.transientAttempts, 3);
  assert.equal(recovery.next.recoveryCycles, 3);
});

test('Voice call lifecycle warns at twenty-eight minutes and ends at thirty without regard to transport renewals', () => {
  const startedAt = 1_000_000;
  assert.equal(
    getVoiceSessionLifecycleAction({ now: startedAt + VOICE_MAX_CALL_WARNING_MS, sessionStartedAt: startedAt, lastUserActivityAt: startedAt, sessionWarningSent: false }),
    'session-warning',
  );
  assert.equal(
    getVoiceSessionLifecycleAction({ now: startedAt + VOICE_MAX_CALL_MS, sessionStartedAt: startedAt, lastUserActivityAt: startedAt + 10_000, sessionWarningSent: true }),
    'session-end',
  );
});

test('Voice call lifecycle warns a genuinely inactive user at two minutes then ends at three', () => {
  const startedAt = 1_000_000;
  assert.equal(
    getVoiceSessionLifecycleAction({ now: startedAt + VOICE_USER_INACTIVITY_WARNING_MS, sessionStartedAt: startedAt, lastUserActivityAt: startedAt, inactivityWarningSent: false }),
    'inactive-warning',
  );
  assert.equal(
    getVoiceSessionLifecycleAction({ now: startedAt + VOICE_USER_INACTIVITY_END_MS, sessionStartedAt: startedAt, lastUserActivityAt: startedAt, inactivityWarningSent: true }),
    'inactive-end',
  );
});

test('Voice inactivity does not end an active response or provider operation', () => {
  const startedAt = 1_000_000;
  assert.equal(
    getVoiceSessionLifecycleAction({ now: startedAt + VOICE_USER_INACTIVITY_END_MS + 20_000, sessionStartedAt: startedAt, lastUserActivityAt: startedAt, isBusy: true, inactivityWarningSent: true }),
    'none',
  );
});


test('buildVoiceTokenUrl encodes a server-issued fallback grant', () => {
  const url = buildVoiceTokenUrl('https://example.com/api', { fallbackGrant: 'signed grant/one' });
  assert.equal(url, 'https://example.com/api/voice/token?fallback_grant=signed%20grant%2Fone');
});

test('fetchVoiceTokenWithRetry can request a fallback grant without retrying the provider transaction', async () => {
  const calls = [];
  const result = await fetchVoiceTokenWithRetry({
    baseUrl: 'https://example.com/api',
    token: 'fresh',
    fallbackGrant: 'signed-grant',
    maxAttempts: 1,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          token: 'fallback-ephemeral',
          model: 'gemini-2.5-flash-live-preview',
          websocket_url: 'wss://example.com/v1beta/live',
          expires_at: '2026-07-10T18:30:00Z',
          new_session_expires_at: '2026-07-10T18:01:00Z',
          fallback_grant: 'grant-from-server',
          fallback_used: true,
        }),
      };
    },
  });
  assert.equal(result.model, 'gemini-2.5-flash-live-preview');
  assert.equal(result.fallback_grant, 'grant-from-server');
  assert.equal(result.fallback_used, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.com/api/voice/token?fallback_grant=signed-grant');
});
