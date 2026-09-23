/**
 * Whole-call scenarios: what the caller would experience, feature by feature.
 * Each drives the real call controller through scripted Gemini events on a
 * virtual clock (see voice_call_harness.mjs).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { makeCall } from './voice_call_harness.mjs';
import { BARGE_IN_FENCE_MS, OPENER_SILENT_MS, USER_PAUSE_MS } from '../frontend/src/voice/call/callController.ts';
import { EMPTY_GENERATION_GRACE_MS, REPLY_NUDGE_NOTE, SILENT_GENERATION_MS } from '../frontend/src/voice/call/replyGuard.ts';

describe('greeting', () => {
  it('opens with a personal greeting and hands the floor over when it finishes playing', async () => {
    const call = makeCall({ profile: { displayName: 'Sam Rivera' } });
    await call.start();
    assert.equal(call.phase, 'connecting');
    assert.match(call.transport.options.openingContext, /Sam/, 'the opener knows who is calling');

    call.transport.setup();
    assert.equal(call.phase, 'listening');
    call.transport.say('Hey Sam, good evening!', 1500);
    assert.equal(call.phase, 'speaking');
    assert.deepEqual(call.ui.turns, [['model', 'Hey Sam, good evening!']]);

    await call.advance(1600);
    assert.equal(call.phase, 'listening');
    assert.ok(call.transport.openingFinishedCalls >= 1, 'the microphone hold is released after the greeting');
  });

  it('asks again once when the greeting comes back empty', async () => {
    const call = makeCall();
    await call.start();
    call.transport.setup();
    call.transport.generationComplete();
    assert.equal(call.transport.openerRetries, 1);
    call.transport.generationComplete();
    assert.equal(call.transport.openerRetries, 1, 'only once');
  });

  it('asks again once when no greeting arrives at all', async () => {
    const call = makeCall();
    await call.start();
    call.transport.setup();
    await call.advance(OPENER_SILENT_MS + 300);
    assert.equal(call.transport.openerRetries, 1);
    await call.advance(OPENER_SILENT_MS);
    assert.equal(call.transport.openerRetries, 1);
  });

  it('continues a chat thread instead of greeting cold', async () => {
    const call = makeCall({ threadNote: 'User: work was rough' });
    await call.start();
    assert.equal(call.transport.options.skipGreeting, true);
    assert.equal(call.transport.options.threadNote, 'User: work was rough');
  });
});

describe('the caller is always heard', () => {
  it('sends every microphone frame, including while MindPal is talking', async () => {
    // The regression: short replies like "no, I didn't" never reached Gemini's
    // turn detection. Nothing on the client may drop caller audio.
    const call = makeCall();
    await call.ready();
    const before = call.transport.pcmSent;
    for (let i = 0; i < 50; i += 1) call.mic.frame(0.01);
    assert.equal(call.transport.pcmSent - before, 50, 'quiet frames go up too; Gemini decides what is speech');

    call.transport.modelText('Let me think about that.');
    call.transport.audio(2000);
    for (let i = 0; i < 20; i += 1) call.mic.frame(0.3);
    assert.equal(call.transport.pcmSent - before, 70, 'and frames during MindPal speech');
  });

  it('turns a short "No, I didn\'t." into a turn and a reply', async () => {
    const call = makeCall();
    await call.ready();
    await call.userSays("No, I didn't.");
    assert.equal(call.ui.inputCaption, "No, I didn't.");
    assert.equal(call.phase, 'userSpeaking');

    await call.advance(USER_PAUSE_MS + 300);
    assert.equal(call.phase, 'waitingReply');
    assert.deepEqual(call.ui.turns.at(-1), ['user', "No, I didn't."]);
    assert.equal(call.ui.thinking.at(-1), true, 'thinking dots while the reply is coming');
    assert.equal(call.control.syncs.at(-1).isFinal, true, 'the turn went to the safety classifier');
    assert.match(call.control.syncs.at(-1).input, /No, I didn't\./);

    call.transport.say('Oh, okay. What happened instead?', 1200);
    assert.equal(call.ui.thinking.at(-1), false);
    assert.deepEqual(call.ui.turns.at(-1), ['model', 'Oh, okay. What happened instead?']);
  });

  it('keeps a long story with short pauses as one turn', async () => {
    const call = makeCall();
    await call.ready();
    await call.userSays('So yesterday I went to the university and');
    await call.advance(700);
    await call.userSays('my friend told me she is moving to another city');
    await call.advance(900);
    await call.userSays('and I do not know how to feel about it');
    assert.equal(call.ui.turns.filter(([role]) => role === 'user').length, 0, 'not cut mid-story');

    await call.advance(USER_PAUSE_MS + 300);
    const userTurns = call.ui.turns.filter(([role]) => role === 'user');
    assert.equal(userTurns.length, 1);
    assert.match(userTurns[0][1], /^So yesterday .* feel about it$/);
  });

  it('commits the turn as soon as Gemini starts answering, even before the pause', async () => {
    const call = makeCall();
    await call.ready();
    await call.userSays('How are you?');
    call.transport.say('Doing well, thanks!', 800);
    assert.deepEqual(call.ui.turns.slice(-2), [
      ['user', 'How are you?'],
      ['model', 'Doing well, thanks!'],
    ]);
  });

  it('shows no caption and no turn for noise markers', async () => {
    const call = makeCall();
    await call.ready();
    call.transport.userText('<noise>');
    call.transport.userText(' <ctrl46>');
    assert.equal(call.ui.inputCaption, '');
    assert.equal(call.phase, 'listening');
    await call.advance(USER_PAUSE_MS * 2);
    assert.equal(call.ui.turns.filter(([role]) => role === 'user').length, 0);
  });
});

describe('barge-in', () => {
  it('stops MindPal immediately when Gemini reports an interruption', async () => {
    const call = makeCall();
    await call.ready();
    call.transport.modelText('So what I think you should do is');
    call.transport.audio(3000);
    assert.equal(call.phase, 'speaking');

    call.transport.interrupted();
    assert.equal(call.playback.flushes, 1);
    assert.equal(call.playback.isPlaying(), false, 'silent within the same event');
    assert.equal(call.phase, 'userSpeaking');
    assert.deepEqual(call.ui.turns.at(-1), ['model', 'So what I think you should do is'], 'what was said stays in the transcript');
  });

  it('drops leftover audio of the cut reply, then plays the next one', async () => {
    const call = makeCall();
    await call.ready();
    call.transport.modelText('Long answer');
    call.transport.audio(2000);
    call.transport.interrupted();
    call.transport.audio(200);
    assert.equal(call.playback.isPlaying(), false, 'leftover chunks are not played');

    await call.userSays('wait wait');
    await call.advance(BARGE_IN_FENCE_MS);
    call.transport.say('Sorry, go on.', 600);
    assert.equal(call.playback.isPlaying(), true);
    assert.equal(call.phase, 'speaking');
  });

  it('ignores an interruption when nothing is playing', async () => {
    const call = makeCall();
    await call.ready();
    call.transport.interrupted();
    assert.equal(call.playback.flushes, 0);
    assert.equal(call.phase, 'listening');
  });

  it('settles back to listening when the interruption was only a cough', async () => {
    const call = makeCall();
    await call.ready();
    call.transport.modelText('Here is a thought');
    call.transport.audio(2000);
    call.transport.interrupted();
    await call.advance(USER_PAUSE_MS + 300);
    assert.equal(call.phase, 'listening');
    assert.equal(call.ui.thinking.includes(true), false, 'no reply is owed for a cough');
    const report = call.session.traceReport('cough');
    const spurious = report.events.find((e) => e.category === 'interrupt' && e.event === 'spurious_barge_in');
    assert.ok(spurious, 'logged spurious barge-in trace event');
  });
});

describe('a reply is always given, and never twice', () => {
  it('nudges once when Gemini closes an empty generation', async () => {
    const call = makeCall();
    await call.ready();
    await call.userSays('I feel stuck');
    await call.advance(USER_PAUSE_MS + 300);
    call.transport.generationComplete();
    await call.advance(EMPTY_GENERATION_GRACE_MS + 300);
    assert.deepEqual(call.transport.clientContent, [REPLY_NUDGE_NOTE]);
    await call.advance(10_000);
    assert.equal(call.transport.clientContent.length, 1, 'once per turn');
  });

  it('nudges when Gemini holds a generation of <ctrl46> only (trace 07-55)', async () => {
    const call = makeCall();
    await call.ready();
    await call.userSays('and she said she does not like men');
    call.transport.modelText('<ctrl46>');
    await call.advance(USER_PAUSE_MS + 300);
    assert.equal(call.transport.clientContent.length, 0);
    await call.advance(SILENT_GENERATION_MS);
    assert.deepEqual(call.transport.clientContent, [REPLY_NUDGE_NOTE], 'about 1.5s, not the 10.6s Gemini took');
  });

  it('never nudges a reply that is slow but real', async () => {
    const call = makeCall();
    await call.ready();
    await call.userSays('Tell me something');
    await call.advance(USER_PAUSE_MS + 6_000);
    call.transport.say('Here is something.', 800);
    await call.advance(5_000);
    assert.equal(call.transport.clientContent.length, 0);
  });

  it('does not nudge when the caller simply carried on talking', async () => {
    const call = makeCall();
    await call.ready();
    await call.userSays('So');
    await call.advance(USER_PAUSE_MS + 300);
    call.transport.generationComplete();
    await call.userSays('what I mean is');
    await call.advance(EMPTY_GENERATION_GRACE_MS + 300);
    assert.equal(call.transport.clientContent.length, 0);
    assert.equal(call.ui.thinking.at(-1), true, 'thinking again after the second pause');
  });
});

describe('mute', () => {
  it('stops the microphone track and sends nothing', async () => {
    const call = makeCall();
    await call.ready();
    call.session.setMuted(true);
    assert.equal(call.mic.enabled, false);
    const before = call.transport.pcmSent;
    call.mic.frame(0.3);
    assert.equal(call.transport.pcmSent, before);
    call.session.setMuted(false);
    call.mic.frame(0.3);
    assert.equal(call.transport.pcmSent, before + 1);
  });
});

describe('reconnect', () => {
  it('replaces a dropped socket once, carrying the conversation, without greeting again', async () => {
    const call = makeCall();
    await call.ready();
    await call.userSays('My exam is tomorrow');
    await call.advance(USER_PAUSE_MS + 300);
    call.transport.drop();
    await call.advance(100);
    assert.equal(call.control.renewals, 1);
    assert.equal(call.transports.length, 2);
    const next = call.transport;
    assert.equal(next.options.skipGreeting, true);
    assert.match(next.options.continuation, /My exam is tomorrow/);
    next.setup();
    assert.equal(call.phase, 'listening');
    assert.equal(call.ui.fallbacks.length, 0);
  });

  it('reconnects on go_away', async () => {
    const call = makeCall();
    await call.ready();
    call.transport.goAway();
    await call.advance(100);
    assert.equal(call.transports.length, 2);
  });

  it('ends the call when a reconnect never gets set up and drops again', async () => {
    const call = makeCall();
    await call.ready();
    call.transport.drop();
    await call.advance(100);
    call.transport.drop();
    await call.advance(100);
    assert.equal(call.phase, 'ended');
    assert.equal(call.ui.fallbacks.length, 1);
  });

  it('reconnects when the provider socket stalls silently while microphone is active', async () => {
    const call = makeCall();
    await call.ready();
    call.transport.isStalled = () => true;
    await call.advance(100);
    assert.equal(call.control.renewals, 1);
    assert.equal(call.transports.length, 2);
    const report = call.session.traceReport('test');
    const stallEvent = report.events.find((e) => e.category === 'socket' && e.event === 'asr_stall_reconnect');
    assert.ok(stallEvent, 'logged asr_stall_reconnect trace event');
  });
});

describe('safety', () => {
  it('moves into support and sends the note when MindPal is idle, not mid-reply', async () => {
    const call = makeCall();
    await call.ready();
    call.control.verdicts.push({ ok: true, action: 'stay_support', session_note: 'Slow down and stay.' });
    await call.userSays('I do not want to be here anymore');
    call.transport.modelText('I am');
    call.transport.audio(1500);
    await call.advance(USER_PAUSE_MS + 300);
    assert.ok(call.ui.statuses.includes('stay_support') || call.session.isStayingForSupport);
    assert.equal(call.transport.notes.length, 0, 'not while MindPal is speaking');
    call.transport.generationComplete();
    call.transport.turnComplete();
    await call.advance(1_600);
    assert.deepEqual(call.transport.notes, ['Slow down and stay.']);
  });

  it('names immediate help right away, once, and keeps the call open', async () => {
    const call = makeCall();
    await call.ready();
    call.control.verdicts.push({ ok: true, action: 'stay_support', imminent: true, danger_kind: 'self_harm' });
    call.control.verdicts.push({ ok: true, action: 'stay_support', imminent: true, danger_kind: 'self_harm' });
    await call.userSays('I have the pills here');
    await call.advance(USER_PAUSE_MS + 300);
    assert.equal(call.transport.notes.length, 1);
    await call.userSays('I mean it');
    await call.advance(USER_PAUSE_MS + 300);
    assert.equal(call.transport.notes.length, 1, 'once per call');
    assert.notEqual(call.phase, 'ended');
  });

  it('acts on the model rating risk through its tool', async () => {
    const call = makeCall();
    await call.ready();
    call.transport.tool('report_risk', { risk: 5, kind: 'self_harm' });
    assert.equal(call.session.isStayingForSupport, true);
    assert.equal(call.transport.toolResponses.length, 1);
    assert.equal(call.control.risks.length, 1);
  });

  it('classifies on a heartbeat during silence', async () => {
    const call = makeCall();
    await call.ready();
    const before = call.control.syncs.length;
    await call.advance(13_000);
    assert.ok(call.control.syncs.length > before);
    assert.equal(call.control.syncs.at(-1).isFinal, false);
  });

  it('ends the call when the server has lost the session', async () => {
    const call = makeCall();
    await call.ready();
    call.control.sessionMissing = true;
    await call.userSays('hello');
    await call.advance(USER_PAUSE_MS + 300);
    assert.equal(call.phase, 'ended');
    assert.match(call.ui.fallbacks[0], /ended on the server/);
  });
});

describe('ending', () => {
  it('ends at the session limit with a clear message', async () => {
    const call = makeCall({ grant: { session_limit_s: 60 } });
    await call.ready();
    await call.advance(60_000);
    assert.equal(call.phase, 'ended');
    assert.match(call.ui.fallbacks[0], /30-minute limit/);
  });

  it('hangs up cleanly and hands back the transcript and trace', async () => {
    const call = makeCall();
    await call.ready();
    await call.userSays('Thanks for listening');
    call.transport.say('Anytime.', 500);
    await call.session.hangup();
    assert.equal(call.phase, 'ended');
    assert.equal(call.mic.stopped, true);
    assert.ok(call.transport.closed);
    assert.equal(call.control.teardowns.length, 1);
    assert.match(call.ui.ended.inputTranscript, /Thanks for listening/);
    assert.match(call.ui.ended.outputTranscript, /Anytime\./);
    assert.ok(call.ui.trace.findings, 'the flight recorder is attached');
  });

  it('says which microphone problem it was', async () => {
    const error = Object.assign(new Error('Device in use'), { name: 'NotReadableError' });
    const call = makeCall({ micError: error });
    await call.start();
    assert.equal(call.phase, 'ended');
    assert.equal(call.ui.fallbacks.length, 1);
    assert.doesNotMatch(call.ui.fallbacks[0], /permission is required/i);
  });

  it('falls back to text when no live session can be minted', async () => {
    const call = makeCall({ mint: async () => Promise.reject(new Error('Voice is off today.')) });
    await call.start();
    assert.deepEqual(call.ui.fallbacks, ['Voice is off today.']);
    assert.ok(call.ui.statuses.includes('unavailable:Voice is off today.'));
  });
});

describe('the face listens', () => {
  it('nods at a phrase ending from the voice alone, with no words at all', async () => {
    // Captions can stall for 20s on a long story. The nod must not wait for them.
    const call = makeCall();
    await call.ready();
    await call.voice(1_500);
    assert.deepEqual(call.ui.reactions, ['nod']);
  });

  it('shows what the phrase meant, whatever the language', async () => {
    const asked = [];
    const call = makeCall({
      classify: async (text, context, speaker = 'caller') => {
        if (speaker === 'caller') asked.push({ text, context });
        return speaker === 'caller' ? 'smile' : 'none';
      },
    });
    await call.ready();
    call.transport.userText(' نجحت في الامتحان أخيرا');
    await call.voice(1_500);
    assert.deepEqual(asked, [{ text: 'نجحت في الامتحان أخيرا', context: '' }], 'sent as spoken, no word lists');
    assert.deepEqual(call.ui.reactions, ['nod', 'smile']);
    assert.ok(call.ui.looks.includes('smile_eyes'));
    assert.equal(call.transport.notes.length + call.transport.clientContent.length, 0, 'nothing sent to Gemini');
  });

  it('asks once per phrase, only about new words', async () => {
    const asked = [];
    const call = makeCall({
      classify: async (text, context, speaker = 'caller') => {
        if (speaker === 'caller') asked.push([text, context]);
        return 'none';
      },
    });
    await call.ready();
    call.transport.userText(' so I went to the shop');
    await call.voice(1_500);
    call.transport.userText(' and they were closed');
    await call.voice(1_500);
    assert.deepEqual(asked, [
      ['so I went to the shop', ''],
      ['and they were closed', 'so I went to the shop'],
    ]);
    assert.deepEqual(call.ui.reactions, ['nod', 'nod'], '"none" leaves just the nod');
  });

  it('does not react to its own voice, or to an answer that arrives after it started talking', async () => {
    let resolve;
    const call = makeCall({ classify: () => new Promise((r) => (resolve = r)) });
    await call.ready();
    call.transport.userText(' I got the job');
    await call.voice(1_500);
    call.transport.modelText('Oh wow!');
    call.transport.audio(2_000);
    await call.voice(1_500);
    resolve('smile');
    await call.advance(50);
    // Mic energy this loud while MindPal speaks is a barge-in (the duplex
    // contract): playback is flushed and the caller holds the floor, so the end
    // of their phrase earns a nod. What must never happen is the late smile: the
    // classification was asked before MindPal spoke, so it is stale.
    assert.equal(call.playback.flushes, 1, 'loud caller speech over MindPal is a barge-in');
    assert.deepEqual(call.ui.reactions, ['nod', 'nod'], 'no late smile from a stale classification');
  });

  it('never applies a reaction classified before MindPal spoke, even after it finishes', async () => {
    let resolve;
    const call = makeCall({ classify: () => new Promise((r) => (resolve = r)) });
    await call.ready();
    call.transport.userText(' I got the job');
    await call.voice(1_500);
    call.transport.say('Oh wow, congratulations!', 800); // speaks and finishes, no barge-in
    await call.advance(1_000);
    resolve('smile');
    await call.advance(50);
    assert.deepEqual(call.ui.reactions, ['nod']);
  });

  it('keeps nodding when the classifier is unreachable', async () => {
    const call = makeCall({ classify: async () => Promise.reject(new Error('offline')) });
    await call.ready();
    call.transport.userText(' anyway it was a long day');
    await call.voice(1_500);
    await call.advance(50);
    assert.deepEqual(call.ui.reactions, ['nod']);
  });
});

describe('the face matches what MindPal is saying', () => {
  /** Answers by speaker, and records MindPal's sentences. */
  function toneClassifier(tones) {
    const said = [];
    const classify = async (text, _context, speaker = 'caller') => {
      if (speaker !== 'mindpal') return 'none';
      said.push(text);
      return tones[text] ?? 'none';
    };
    return { said, classify };
  }

  it('reads each sentence and shows its tone when that sentence is heard, not when its text arrives', async () => {
    const { said, classify } = toneClassifier({ 'Haha, no way!': 'smile' });
    const call = makeCall({ classify });
    await call.ready();
    const looksBefore = call.ui.looks.length;
    // First sentence: 2s of audio queued. Second sentence's text arrives now,
    // but is heard only after the first finishes.
    call.transport.modelText('Okay so here is the thing. ');
    call.transport.audio(2_000);
    call.transport.modelText('Haha, no way! ');
    call.transport.audio(1_000);
    await call.advance(50);
    assert.deepEqual(said.slice(-2), ['Okay so here is the thing.', 'Haha, no way!']);
    assert.equal(call.ui.looks.length, looksBefore, 'not yet: its audio has not started');
    await call.advance(2_300);
    assert.deepEqual(call.ui.looks.slice(looksBefore), ['smile_eyes'], 'smiles as the laugh plays');
  });

  it('splits sentences in scripts without spaces', async () => {
    const { said, classify } = toneClassifier({});
    const call = makeCall({ classify });
    await call.ready();
    call.transport.modelText('本当に？それはすごいね。');
    call.transport.audio(1_000);
    await call.advance(50);
    assert.deepEqual(said.slice(-2), ['本当に？', 'それはすごいね。']);
  });

  it('drops expressions for sentences that were never heard because the caller cut in', async () => {
    const { classify } = toneClassifier({ 'That is wonderful news!': 'smile' });
    const call = makeCall({ classify });
    await call.ready();
    const looksBefore = call.ui.looks.length;
    call.transport.modelText('Let me think about this for a second. ');
    call.transport.audio(3_000);
    call.transport.modelText('That is wonderful news! ');
    call.transport.audio(1_000);
    await call.advance(50);
    call.transport.interrupted();
    await call.advance(5_000);
    assert.equal(call.ui.looks.length, looksBefore);
  });

  it('shows the last sentence too, even with no trailing space', async () => {
    const { classify } = toneClassifier({ 'I am so sorry to hear that.': 'concern' });
    const call = makeCall({ classify });
    await call.ready();
    call.transport.say('I am so sorry to hear that.', 1_500);
    await call.advance(200);
    assert.ok(call.ui.looks.includes('concerned'));
  });
});

/** Active, not fading out: what the face is actually showing now. */
function showing(call, expression) {
  return call.ui.commands.some((c) => c.expression === expression && !c.supersededAt);
}

describe('the face thinks and remembers', () => {
  it('thinks from the caller finishing until MindPal starts talking', async () => {
    const call = makeCall();
    await call.ready();
    await call.userSays('What should I do about my exam');
    assert.equal(showing(call, 'thinking'), false, 'not while they are still talking');
    await call.advance(USER_PAUSE_MS + 300);
    assert.equal(showing(call, 'thinking'), true);
    call.transport.say('Let us break it down.', 1_000);
    assert.equal(showing(call, 'thinking'), false, 'the first sound ends it');
  });

  it('reads back while a memory lookup runs, then answers the model when idle', async () => {
    let answer;
    const asked = [];
    const call = makeCall({
      recall: (sessionId, tool, query) => {
        asked.push({ sessionId, tool, query });
        return new Promise((resolve) => (answer = resolve));
      },
    });
    await call.ready();
    call.transport.tool('search_memory', { query: 'exam' });
    await call.advance(10);
    assert.deepEqual(asked, [{ sessionId: 'vs_test', tool: 'search_memory', query: 'exam' }]);
    assert.equal(showing(call, 'reading'), true, 'eyes read back while it looks');
    assert.equal(call.transport.toolResponses.length, 0, 'no answer until the lookup returns');

    answer({ result: '- Physics exam on Monday', found: true });
    await call.advance(10);
    assert.equal(showing(call, 'reading'), false);
    const [response] = call.transport.toolResponses.at(-1).toolResponse.functionResponses;
    assert.equal(response.name, 'search_memory');
    assert.equal(response.response.result, '- Physics exam on Monday');
    assert.equal(response.response.scheduling, 'WHEN_IDLE', 'MindPal finishes its sentence, then uses it');
  });

  it('still answers the model when a lookup fails', async () => {
    const call = makeCall({ recall: async () => Promise.reject(new Error('offline')) });
    await call.ready();
    call.transport.tool('search_past_chats', { query: 'sister' });
    await call.advance(10);
    const [response] = call.transport.toolResponses.at(-1).toolResponse.functionResponses;
    assert.match(response.response.result, /Nothing relevant found/);
    assert.equal(showing(call, 'reading'), false);
  });

  it('drops a lookup answer after the caller cut in (Gemini discards the call)', async () => {
    let answer;
    const call = makeCall({ recall: () => new Promise((resolve) => (answer = resolve)) });
    await call.ready();
    call.transport.modelText('Let me think back');
    call.transport.audio(2_000);
    call.transport.tool('search_memory', { query: 'exam' });
    call.transport.interrupted();
    answer({ result: 'late', found: true });
    await call.advance(10);
    assert.equal(call.transport.toolResponses.length, 0);
  });

  it('preserves interrupted recall results and queues them to Gemini on the next turn', async () => {
    let answer;
    const call = makeCall({ recall: () => new Promise((resolve) => (answer = resolve)) });
    await call.ready();
    call.transport.modelText('Let me think back');
    call.transport.audio(2_000);
    call.transport.tool('search_memory', { query: 'exam' });
    call.transport.interrupted();
    answer({ result: 'Physics exam on Monday at 9am', found: true });
    await call.advance(10);
    assert.equal(call.transport.toolResponses.length, 0, 'Gemini dropped the function call id');
    // Caller finishes interrupting and settles to listening
    await call.advance(USER_PAUSE_MS + 100);
    assert.equal(call.phase, 'listening');
    assert.ok(
      call.transport.notes.some((note) => note.includes('Physics exam on Monday at 9am')),
      'lookup result queued and delivered as application note',
    );
  });

  it('keeps answering face tools right away alongside a lookup', async () => {
    const call = makeCall({ recall: () => new Promise(() => {}) });
    await call.ready();
    call.transport.handlers.onToolCalls([
      { id: 'a', name: 'set_expression', args: { expression: 'wink' } },
      { id: 'b', name: 'search_memory', args: { query: 'x' } },
    ]);
    const [only] = call.transport.toolResponses;
    assert.deepEqual(only.toolResponse.functionResponses.map((r) => r.name), ['set_expression']);
  });
});

describe('the speaking face lasts the whole reply', () => {
  it('carries the tone through neutral sentences and holds each for its length', async () => {
    const tones = { 'Haha, that is hilarious!': 'laugh' };
    const call = makeCall({ classify: async (text, _c, speaker) => (speaker === 'mindpal' ? tones[text] ?? 'none' : 'none') });
    await call.ready();
    const before = call.ui.looks.length;
    call.transport.modelText('Haha, that is hilarious! ');
    call.transport.audio(1_600);
    call.transport.modelText('So after all of that you still went to the party and danced all night long. ');
    call.transport.audio(5_000);
    call.transport.modelText('I would have loved to see the look on their faces when you walked in. ');
    call.transport.audio(4_500);
    call.transport.generationComplete();
    await call.advance(50);
    await call.advance(11_000);
    const looks = call.ui.looks.slice(before);
    assert.deepEqual(looks, ['amused', 'amused', 'amused'], 'no blank face mid-reply');
    assert.ok(call.ui.reactions.includes('laugh'), 'the laugh bounces the head once');
    assert.equal(call.ui.reactions.filter((k) => k === 'laugh').length, 1, 'carried tone does not bounce again');
  });

  it('lets the tone go once the reply has finished playing', async () => {
    const call = makeCall({ classify: async (_t, _c, speaker) => (speaker === 'mindpal' ? 'tender' : 'none') });
    await call.ready();
    call.transport.say('I am really sorry that happened to you.', 2_000);
    await call.advance(200);
    assert.equal(showing(call, 'soften'), true);
    await call.advance(2_500);
    assert.equal(showing(call, 'soften'), false);
  });
});

describe('a long story keeps the face alive', () => {
  it('nods all the way through a 60 second story, not only at the start', async () => {
    const call = makeCall();
    await call.ready();
    const start = call.clock.now();
    // Phrases of 2 to 3.6 seconds with short breaths between them, for a minute.
    for (let i = 0; call.clock.now() - start < 60_000; i += 1) {
      await call.voice(2_000 + (i % 5) * 400, 350);
    }
    const times = call.ui.reactionTimes.map((t) => t - start);
    assert.ok(times.length >= 15, `only ${times.length} reactions in a minute`);
    assert.ok(times.some((t) => t > 50_000), 'still reacting near the end');
    assert.ok(call.ui.reactions.includes('double_nod'), 'longer phrases get a fuller nod');
  });
});
