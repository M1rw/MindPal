import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { describeMicFailure, microphoneApiAvailable } from '../frontend/src/voice/audio/micErrors.ts';

/** A DOMException as the browser raises it, without needing a browser. */
function domError(name, message = 'failed') {
  const error = new Error(message);
  error.name = name;
  return error;
}

const realNavigator = globalThis.navigator;
function withMicApi(present) {
  Object.defineProperty(globalThis, 'navigator', {
    value: present ? { mediaDevices: { getUserMedia: () => {} } } : {},
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', {
    value: realNavigator,
    configurable: true,
    writable: true,
  });
});

describe('telling the caller what actually stopped the microphone', () => {
  it('only blames permission when permission was the problem', () => {
    withMicApi(true);
    const denied = describeMicFailure(domError('NotAllowedError'));
    assert.equal(denied.reason, 'permission_denied');
    assert.match(denied.message, /blocked/i);
  });

  it('does not send someone to permission settings for a busy device', () => {
    // The most misdiagnosed case by far: permission IS granted, another tab or
    // app holds the microphone, and the old message sent the caller to a
    // browser setting where nothing was wrong.
    withMicApi(true);
    const busy = describeMicFailure(domError('NotReadableError'));
    assert.equal(busy.reason, 'device_busy');
    assert.match(busy.message, /another app or tab/i);
    assert.doesNotMatch(busy.message, /permission/i);
  });

  it('says there is no microphone when there is no microphone', () => {
    withMicApi(true);
    const missing = describeMicFailure(domError('NotFoundError'));
    assert.equal(missing.reason, 'no_device');
    assert.match(missing.message, /No microphone was found/i);
    assert.doesNotMatch(missing.message, /permission/i);
  });

  it('names an insecure page rather than guessing at permission', () => {
    // navigator.mediaDevices is undefined outside a secure context, so the call
    // throws a TypeError that looks nothing like a permission error.
    withMicApi(false);
    const insecure = describeMicFailure(domError('TypeError'));
    assert.equal(insecure.reason, 'insecure_context');
    assert.match(insecure.message, /https/i);
    assert.equal(microphoneApiAvailable(), false);
  });

  it('always leaves the caller somewhere to go', () => {
    withMicApi(true);
    for (const name of [
      'NotAllowedError',
      'NotFoundError',
      'NotReadableError',
      'OverconstrainedError',
      'AbortError',
      'SecurityError',
      'WhateverElseError',
    ]) {
      const failure = describeMicFailure(domError(name));
      assert.match(failure.message, /dictate into the composer/, `${name} left no way forward`);
      assert.ok(failure.reason, `${name} produced no loggable reason`);
    }
  });

  it('carries a stable reason into the trace, not just prose', () => {
    withMicApi(true);
    const reasons = new Set(
      ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'AbortError'].map(
        (name) => describeMicFailure(domError(name)).reason,
      ),
    );
    assert.equal(reasons.size, 4, 'four different causes must not share one reason');
  });
});

describe('a worklet the page was not allowed to load', () => {
  it('does not call a CSP refusal a microphone problem', () => {
    // The console line that finally named it:
    //   Loading the script 'blob:http://127.0.0.1:8765/...' violates the
    //   following Content Security Policy directive: "script-src 'self' ..."
    // The caller saw "The microphone could not be started."
    withMicApi(true);
    const blocked = describeMicFailure(domError('CaptureWorkletError'));
    assert.equal(blocked.reason, 'worklet_blocked');
    assert.match(blocked.message, /not a microphone permission problem/i);
  });

  it('treats the downstream InvalidStateError the same way', () => {
    // Swallowing the addModule failure moved the crash one line down, to
    // `new AudioWorkletNode(...)`, which throws InvalidStateError.
    withMicApi(true);
    assert.equal(describeMicFailure(domError('InvalidStateError')).reason, 'worklet_blocked');
  });
});

describe('the policy that has to allow the worklets', () => {
  const source = readFileSync(new URL('../backend/main.py', import.meta.url), 'utf8');
  // Comment lines quote the directive too, so read only real code lines. A test
  // that asserts against the prose explaining a policy proves nothing about it.
  const csp = source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  const scriptSrc = csp.match(/"script-src ([^"]+)"/)?.[1] ?? '';

  it('lets script-src load a blob, which is where AudioWorklet modules come from', () => {
    // worker-src blob: is NOT enough: Chrome loads an audioWorklet.addModule()
    // URL under script-src, falling back from script-src-elem.
    assert.ok(scriptSrc, 'script-src not found in main.py');
    assert.match(scriptSrc, /\bblob:/, `script-src must allow blob:, got "${scriptSrc}"`);
  });

  it('still refuses arbitrary remote script', () => {
    assert.doesNotMatch(scriptSrc, /\*|https:(?!\/\/)/, 'script-src must stay on an allow-list');
    assert.match(csp, /"object-src 'none'"/);
    assert.match(csp, /"frame-ancestors 'none'"/);
    assert.match(csp, /"frame-src [^"]*\*\.firebaseapp\.com/);
  });

  it('allows the sign-in client live voice depends on', () => {
    assert.match(scriptSrc, /accounts\.google\.com/);
    assert.match(csp, /"frame-src [^"]*accounts\.google\.com/);
  });

  it('allows Vercel preview feedback tooling', () => {
    assert.match(scriptSrc, /vercel\.live/);
    assert.match(csp, /"frame-src [^"]*vercel\.live/);
    assert.match(csp, /"font-src [^"]*vercel\.live/);
  });
});
