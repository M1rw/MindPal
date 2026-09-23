/**
 * Crisis enforcement contracts for live duplex voice.
 *
 * The browser owns the only socket to Gemini Live. Stay-support keeps that
 * socket. Escalate-pause is the only path that stops the model.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { applicationNoteMessage, isEscalateAction, LOCAL_CRISIS_SCRIPT, shouldSpeakFirst, STAY_SUPPORT_NOTE, situationNudgeMessage } from '../../frontend/src/voice/safety/crisisEnforcer.ts';
import { crisisEvidence, isCrisisSpeech, normalizeForCrisis } from '../../frontend/src/voice/safety/crisisLexicon.ts';
import { canOperateMute, CRISIS_DISCLAIMER, CRISIS_HEADING, CRISIS_RESOURCES, isCrisisSurface, STAY_SUPPORT_HINT, STAY_SUPPORT_STATUS } from '../../frontend/src/voice/safety/crisisUx.ts';
import { ControlPlaneClient, normalizeControlAction } from '../../frontend/src/voice/control/controlPlane.ts';
import { liveVoiceCaption } from '../../frontend/src/voice/session/caption.ts';
import { useVoiceStore } from '../../frontend/src/store/voice.ts';

const CORPUS = JSON.parse(readFileSync(new URL('../fixtures/voice_crisis_phrases.json', import.meta.url), 'utf8'));

describe('Crisis lexicon matches ASR reality', () => {
  it('still folds the shared corpus (chat-side helper; not the live freeze authority)', () => {
    for (const phrase of CORPUS.crisis) {
      assert.ok(isCrisisSpeech(phrase), `missed disclosure: ${phrase}`);
    }
  });

  it('leaves ordinary speech alone', () => {
    for (const phrase of CORPUS.ordinary) {
      assert.equal(crisisEvidence(phrase), null, `false positive: ${phrase}`);
    }
  });

  it('matches the cumulative transcript when no single delta does', () => {
    for (const deltas of CORPUS.split_deltas) {
      for (const delta of deltas) {
        assert.equal(crisisEvidence(delta), null, `single delta matched: ${delta}`);
      }
      assert.ok(isCrisisSpeech(deltas.join('')), `cumulative missed: ${deltas.join('')}`);
    }
  });

  it('folds spacing, case and dropped apostrophes the way the backend does', () => {
    assert.equal(normalizeForCrisis("I don't want to LIVE, anymore!!"), 'i dont want to live anymore');
    for (const variant of ['kill myself', 'kill my self', 'Killing My Self', "i'll kill my self"]) {
      assert.ok(isCrisisSpeech(variant), variant);
    }
  });

  it('does not read a referral as a disclosure', () => {
    assert.equal(crisisEvidence('call the suicide and crisis lifeline on 988'), null);
    assert.equal(crisisEvidence('i could kill myself laughing'), null);
  });
});

describe('Stay-support does not hang up', () => {

  it('builds a labeled application note, not a product pause', () => {
    const message = applicationNoteMessage(STAY_SUPPORT_NOTE);
    assert.match(message.realtimeInput.text, /\[\[MindPal\]\]/);
    assert.match(STAY_SUPPORT_NOTE, /You are MindPal/);
    assert.match(STAY_SUPPORT_NOTE, /988/);
    assert.match(STAY_SUPPORT_NOTE, /741741/);
    assert.match(STAY_SUPPORT_NOTE.toLowerCase(), /not a crisis line/);
    assert.match(STAY_SUPPORT_NOTE, /You are MindPal/);
    assert.match(STAY_SUPPORT_NOTE, /say MindPal/);
    assert.doesNotMatch(STAY_SUPPORT_NOTE.toLowerCase(), /paused for safety/);
    const nudge = situationNudgeMessage('They just said: "running from a killer".');
    assert.match(nudge.clientContent.turns[0].parts[0].text, /running from a killer/);
    assert.equal(nudge.clientContent.turnComplete, true);
  });
});

describe('A failed control plane never reads as continue', () => {
  const client = new ControlPlaneClient('vs_test');
  const realFetch = globalThis.fetch;

  async function withFetch(stub, run) {
    globalThis.fetch = stub;
    try {
      return await run();
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  it('reports safety_unverified when the request throws', async () => {
    const result = await withFetch(
      async () => {
        throw new Error('offline');
      },
      () => client.syncTranscripts('i had a long day', ''),
    );
    assert.equal(result.action, 'safety_unverified');
    assert.equal(result.ok, false);
    assert.notEqual(result.action, 'continue');
  });

  it('reports safety_unverified on a 500', async () => {
    const result = await withFetch(
      async () => new Response('{"detail":"boom"}', { status: 500 }),
      () => client.syncTranscripts('i had a long day', ''),
    );
    assert.equal(result.action, 'safety_unverified');
  });

  it('does not answer continue while a slow response is still in flight', async () => {
    let resolved = false;
    const pending = withFetch(
      async () =>
        new Promise((resolve) =>
          setTimeout(() => {
            resolved = true;
            resolve(new Response('{"ok":true,"action":"continue","safety_verified":true}', { status: 200 }));
          }, 40),
        ),
      () => client.syncTranscripts('i had a long day', ''),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(resolved, false);
    const result = await pending;
    assert.equal(result.action, 'continue');
  });

  it('passes an escalate instruction through as escalate_pause', async () => {
    const result = await withFetch(
      async () =>
        new Response('{"ok":true,"action":"escalate_pause","terminal":true,"crisis_response":"call 988"}', {
          status: 200,
        }),
      () => client.syncTranscripts('i have the pills and i am taking them now', ''),
    );
    assert.equal(result.action, 'escalate_pause');
    assert.equal(result.crisis_response, 'call 988');
  });

  it('maps a legacy crisis_freeze payload to escalate_pause', async () => {
    const result = await withFetch(
      async () =>
        new Response('{"ok":true,"action":"crisis_freeze","terminal":true,"crisis_response":"call 988"}', {
          status: 200,
        }),
      () => client.syncTranscripts('i want to die', ''),
    );
    assert.equal(result.action, 'escalate_pause');
    assert.equal(result.crisis_response, 'call 988');
  });

  it('passes stay_support through without pausing', async () => {
    const result = await withFetch(
      async () =>
        new Response('{"ok":true,"action":"stay_support","terminal":false,"session_note":"stay"}', {
          status: 200,
        }),
      () => client.syncTranscripts('i want to die tonight', ''),
    );
    assert.equal(result.action, 'stay_support');
    assert.equal(result.terminal, false);
    assert.equal(result.session_note, 'stay');
  });

  it('refuses to reconnect a paused session', async () => {
    await withFetch(
      async () => new Response('{"ok":true,"action":"escalate_pause","floor":"crisis_freeze"}', { status: 200 }),
      async () => {
        await assert.rejects(() => client.renew(), /paused for safety/);
      },
    );
  });

});

describe('Crisis surface survives the reflex to close it', () => {
  it('keeps the resources when voice state is reset', () => {
    const store = useVoiceStore.getState();
    store.setIsActive(true);
    store.setUiStatus('crisis_freeze');
    store.setCrisisScript(LOCAL_CRISIS_SCRIPT);

    // Escape / back / End all funnel into resetVoice().
    useVoiceStore.getState().resetVoice();

    assert.equal(useVoiceStore.getState().crisisScript, LOCAL_CRISIS_SCRIPT);
    assert.equal(useVoiceStore.getState().isActive, false);

    useVoiceStore.getState().clearCrisis();
    assert.equal(useVoiceStore.getState().crisisScript, '');
  });

  it('starts a new call with a clean slate', () => {
    useVoiceStore.getState().setCrisisScript('stale resources');
    useVoiceStore.getState().setIsActive(true);
    assert.equal(useVoiceStore.getState().crisisScript, '');
    useVoiceStore.getState().resetVoice();
  });

  it('treats a lingering script as a crisis surface even after the status moves on', () => {
    assert.equal(isCrisisSurface('crisis_freeze', ''), true);
    assert.equal(isCrisisSurface('stay_support', ''), true);
    assert.equal(isCrisisSurface('listening', 'call 988'), true);
    assert.equal(isCrisisSurface('listening', ''), false);
  });
});

describe('Crisis UI is operable and does not overclaim', () => {
  it('lets a distressed user mute without ending the call', () => {
    assert.equal(canOperateMute('crisis_freeze', true), true);
    assert.equal(canOperateMute('stay_support', true), true);
    assert.equal(canOperateMute('listening', true), true);
    assert.equal(canOperateMute('connecting', true), true);
    assert.equal(canOperateMute('holding', true), true);
    assert.equal(canOperateMute('crisis_freeze', false), false);
    assert.equal(canOperateMute('consent', true), false);
    assert.equal(canOperateMute('error', true), false, 'a dead session has no microphone to cut');
  });

  it('offers resources a person can actually reach', () => {
    assert.ok(CRISIS_RESOURCES.length >= 2);
    assert.ok(CRISIS_RESOURCES.some((resource) => resource.href.startsWith('tel:')));
    assert.ok(CRISIS_RESOURCES.some((resource) => resource.href.startsWith('sms:')));
    for (const resource of CRISIS_RESOURCES) {
      assert.ok(resource.label.trim().length > 0);
      assert.ok(resource.detail.trim().length > 0);
    }
    assert.ok(CRISIS_HEADING.trim().length > 0);
    assert.match(STAY_SUPPORT_STATUS, /Still with you/);
    assert.match(STAY_SUPPORT_HINT, /988/);
    assert.match(STAY_SUPPORT_HINT.toLowerCase(), /not a crisis line/);
  });

  it('keeps captions flowing during stay-support', () => {
    const caption = liveVoiceCaption({
      uiStatus: 'stay_support',
      transcript: 'i want to die tonight',
      aiTranscript: 'i am still here with you',
      crisisScript: LOCAL_CRISIS_SCRIPT,
    });
    assert.equal(caption, 'i am still here with you');
    const userOnly = liveVoiceCaption({
      uiStatus: 'stay_support',
      transcript: 'i want to die tonight',
      aiTranscript: '',
      crisisScript: LOCAL_CRISIS_SCRIPT,
    });
    assert.equal(userOnly, 'i want to die tonight');
    const paused = liveVoiceCaption({
      uiStatus: 'crisis_freeze',
      transcript: 'i want to die tonight',
      aiTranscript: '',
      crisisScript: LOCAL_CRISIS_SCRIPT,
    });
    assert.match(paused, /988/);
  });

  it('says what the detection is and is not', () => {
    const copy = `${CRISIS_DISCLAIMER} ${LOCAL_CRISIS_SCRIPT} ${STAY_SUPPORT_HINT}`.toLowerCase();
    assert.ok(copy.includes('not a crisis line'));
    assert.ok(copy.includes('not clinical screening'));
    assert.ok(!copy.includes('keyword'));
    assert.ok(!copy.includes('guarantee'));
    assert.ok(!copy.includes('we will contact'));
    assert.ok(!copy.includes('ai guarantees'));
  });
});

