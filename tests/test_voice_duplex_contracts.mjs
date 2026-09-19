import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createBackchannelMemory } from '../frontend/src/voice/face/backchannel.ts';
import { rollingContinuation } from '../frontend/src/voice/call/lifecycle.ts';
import { equalPowerFadeOut, fadeDiscontinuity, FADE_SECONDS, pcm16Brightness, pcm16Rms, PlaybackQueue, scaleSpeechRms, stepEnvelope } from '../frontend/src/voice/audio/playback.ts';
import { parseLiveMessage, playableAudioChunks, isProviderSafetyBlock, GREETING_NUDGE, GREETING_HOLD_MS, MAX_WS_BUFFERED_BYTES } from '../frontend/src/voice/control/geminiLive.ts';

function pcmChunk() {
  const pcm = new Uint8Array([0, 0, 1, 0]);
  let binary = '';
  pcm.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

describe('Gemini Live parser', () => {
  it('treats setupComplete as ready, not as listening UI', () => {
    const parsed = parseLiveMessage({ setupComplete: {} });
    assert.equal(parsed.setupComplete, true);
    assert.equal(parsed.interrupted, false);
    assert.equal(parsed.audioChunks.length, 0);
  });

  it('extracts audio and ignores thought parts', () => {
    const parsed = parseLiveMessage({
      serverContent: {
        modelTurn: {
          parts: [
            { thought: true, text: 'internal' },
            { inlineData: { data: pcmChunk(), mimeType: 'audio/pcm;rate=24000' } },
          ],
        },
      },
    });
    assert.equal(parsed.audioChunks.length, 1);
    assert.equal(parsed.outputTranscript, '');
  });

  it('surfaces provider interrupted as the barge-in signal', () => {
    const parsed = parseLiveMessage({ serverContent: { interrupted: true } });
    assert.equal(parsed.interrupted, true);
  });

  it('drops audio bundled with interrupted so leftover generation cannot restart', () => {
    const parsed = parseLiveMessage({
      serverContent: {
        interrupted: true,
        modelTurn: {
          parts: [{ inlineData: { data: pcmChunk(), mimeType: 'audio/pcm;rate=24000' } }],
        },
      },
    });
    assert.equal(parsed.interrupted, true);
    assert.equal(parsed.audioChunks.length, 1);
    assert.equal(playableAudioChunks(parsed).length, 0);
  });

  it('reads input finished without treating model turnComplete as a floor steal', () => {
    const parsed = parseLiveMessage({
      serverContent: {
        inputTranscription: { text: 'yeah', finished: true },
      },
    });
    assert.equal(parsed.inputTranscript, 'yeah');
    assert.equal(parsed.inputFinished, true);
    assert.equal(parsed.turnComplete, false);
  });

  it('surfaces Gemini error class from the socket payload', () => {
    const parsed = parseLiveMessage({
      error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Unknown name "proactivity".' },
    });
    assert.equal(parsed.error, 'Gemini INVALID_ARGUMENT: Unknown name "proactivity".');
    assert.equal(parsed.setupComplete, false);
  });

  it('does not treat a provider content block as a session-killing error class', () => {
    assert.equal(isProviderSafetyBlock('Gemini INVALID_ARGUMENT: Unknown name "proactivity".'), false);
    assert.equal(isProviderSafetyBlock('Gemini SAFETY: The request was blocked because of prohibited content.'), true);
    assert.equal(isProviderSafetyBlock('blockedReason: HARM_CATEGORY_HARASSMENT'), true);
    assert.equal(GREETING_NUDGE, 'Hi.');
    assert.ok(GREETING_HOLD_MS >= 1500 && GREETING_HOLD_MS <= 4000);
  });

  it('parses toolCall without waiting on serverContent', () => {
    const parsed = parseLiveMessage({
      toolCall: {
        functionCalls: [{ id: 'function-call-1', name: 'set_expression', args: { expression: 'wink' } }],
      },
    });
    assert.equal(parsed.toolCalls.length, 1);
    assert.equal(parsed.toolCalls[0].name, 'set_expression');
    assert.equal(parsed.toolCalls[0].args.expression, 'wink');
    assert.equal(parsed.setupComplete, false);
    const mood = parseLiveMessage({
      toolCall: {
        functionCalls: [{ id: 'function-call-2', name: 'set_mood', args: { state: 'sleepy', intensity: 0.6 } }],
      },
    });
    assert.equal(mood.toolCalls[0].name, 'set_mood');
    assert.equal(mood.toolCalls[0].args.state, 'sleepy');
  });

  it('reads a session resumption handle from the provider update', () => {
    const parsed = parseLiveMessage({
      sessionResumptionUpdate: { newHandle: 'resume-1', resumable: true },
    });
    assert.equal(parsed.sessionResumptionHandle, 'resume-1');
    const snake = parseLiveMessage({
      session_resumption_update: { new_handle: 'resume-2' },
    });
    assert.equal(snake.sessionResumptionHandle, 'resume-2');
  });
});

describe('Playback fade and generation fence', () => {
  it('uses a short equal-power fade that ends at silence', () => {
    // Raised from 48ms: that read as a hard cut, not a yield. People trail off
    // over roughly 150-250ms when interrupted. Still bounded, because a long
    // fade means MindPal keeps talking over the caller.
    assert.ok(FADE_SECONDS >= 0.12 && FADE_SECONDS <= 0.26);
    const curve = equalPowerFadeOut(1);
    assert.equal(curve[0], 1);
    assert.equal(curve[curve.length - 1], 0);
    for (let i = 1; i < curve.length; i += 1) {
      assert.ok(curve[i] <= curve[i - 1]);
    }
    assert.ok(fadeDiscontinuity(curve) < 0.2);
  });

  it('starts a short greeting that sat under the 70ms prebuffer', () => {
    const queue = new PlaybackQueue();
    const tiny = new Int16Array(240);
    assert.equal(queue.enqueue(tiny), true);
    assert.equal(queue.flushPrebuffer(), true);
  });

  it('rejects audio from the killed generation after interrupt', () => {
    const faded = [];
    const queue = new PlaybackQueue({ onFadeComplete: () => faded.push(true) });
    const pcm = new Int16Array(32);
    const liveGen = queue.currentGeneration;
    assert.equal(queue.enqueue(pcm, liveGen), true);
    const playedMs = queue.flush();
    assert.equal(typeof playedMs, 'number');
    assert.equal(faded.length, 1);
    assert.equal(queue.enqueue(pcm, liveGen), false);
    assert.equal(queue.isFading, false);
    assert.equal(queue.isGated, true);
    assert.equal(queue.enqueue(pcm, queue.currentGeneration), false, 'post-flush chunks of the cut sentence must not play');
    const nextGen = queue.releaseFence();
    assert.equal(queue.isGated, false);
    assert.equal(queue.enqueue(pcm, nextGen), true);
    assert.equal(queue.currentGeneration !== liveGen, true);
  });

  it('maps playback PCM into a smoothed envelope, not a fake emotion', () => {
    assert.ok(scaleSpeechRms(0.08) > 0.5);
    assert.ok(scaleSpeechRms(0.02) > 0 && scaleSpeechRms(0.02) < 0.35);
    const rising = stepEnvelope(0, 1, 0.28, 0.12);
    const falling = stepEnvelope(1, 0, 0.28, 0.12);
    assert.ok(rising > 0.2 && rising < 0.4);
    assert.ok(falling < 0.9 && falling > 0.8);
    const dull = new Int16Array(64);
    dull[0] = 8000;
    dull[1] = 7900;
    dull[2] = 7800;
    const bright = new Int16Array(64);
    for (let i = 0; i < bright.length; i += 1) bright[i] = i % 2 === 0 ? 12000 : -12000;
    assert.ok(pcm16Brightness(bright) > pcm16Brightness(dull));
    assert.ok(pcm16Rms(bright) > 0);
  });
});

describe('Live session construction and echo/backpressure contracts', () => {

  it('carries a short rolling summary when the provider socket restarts', () => {
    const text = rollingContinuation('I have been tired at work', 'That sounds heavy.');
    assert.match(text, /Continuing the same live call/);
    assert.match(text, /tired at work/);
    assert.match(text, /sounds heavy/);
    assert.equal(rollingContinuation('  ', ''), '');
  });

  it('caps websocket capture buffer so late PCM cannot burst into VAD', () => {
    assert.ok(MAX_WS_BUFFERED_BYTES >= 16_000);
    assert.ok(MAX_WS_BUFFERED_BYTES <= 64_000);
  });

});

