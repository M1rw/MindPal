import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  GREETING_HOLD_MS,
  GREETING_NUDGE,
  GeminiLiveAdapter,
  RESUME_NUDGE,
} from '../../frontend/src/voice/control/geminiLive.ts';

/**
 * A socket that records what the adapter sends and lets a test hand it frames.
 *
 * The adapter only ever asks a socket for `readyState`, `send`, `close` and
 * listeners, so a stub is enough to exercise the whole opening handshake.
 */
class FakeSocket {
  static OPEN = 1;

  constructor() {
    this.readyState = 1;
    this.sent = [];
    this.listeners = new Map();
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.readyState = 3;
  }

  addEventListener(name, handler) {
    this.listeners.set(name, handler);
  }

  open() {
    this.listeners.get('open')?.();
  }

  deliver(message) {
    this.listeners.get('message')?.({ data: JSON.stringify(message) });
  }
}

const GRANT = {
  ws_url: 'wss://example.invalid/live',
  token: 'real-token',
  setup: { setup: { model: 'models/test' } },
  setup_timeout_ms: 12000,
  voice_id: 'Kore',
};

let sockets = [];
let adapters = [];
const realWebSocket = globalThis.WebSocket;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realWindow = globalThis.window;

beforeEach(() => {
  sockets = [];
  adapters = [];
  globalThis.WebSocket = class {
    constructor() {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }
  };
  globalThis.WebSocket.OPEN = 1;
  globalThis.WebSocket.CLOSING = 2;
  globalThis.window = { setTimeout: realSetTimeout, clearTimeout: realClearTimeout };
});

afterEach(async () => {
  // Every opened call arms a greeting-hold timer. Left running, it fires after
  // the stubs are gone and surfaces as an unhandled exception in a later test.
  for (const adapter of adapters) await adapter.close(1000, 'test_teardown');
  globalThis.WebSocket = realWebSocket;
  globalThis.window = realWindow;
});

function noopHandlers() {
  return {
    onSetupComplete: () => {},
    onAudio: () => {},
    onInterrupted: () => {},
    onInputTranscript: () => {},
    onOutputTranscript: () => {},
    onError: () => {},
    onClose: () => {},
  };
}

/** Connect, hand over setupComplete, and return everything the adapter sent. */
async function openCall(options) {
  const adapter = new GeminiLiveAdapter(GRANT, noopHandlers(), options);
  adapters.push(adapter);
  adapter.connect();
  const socket = sockets[0];
  socket.open();
  socket.deliver({ setupComplete: {} });
  await new Promise((resolve) => realSetTimeout(resolve, 0));
  return { adapter, socket };
}

/** Text of the first clientContent frame, which is what forces a model turn. */
function openerText(socket) {
  const frame = socket.sent.find((message) => message.clientContent);
  return frame?.clientContent?.turns?.[0]?.parts?.[0]?.text ?? '';
}

function noteTexts(socket) {
  return socket.sent.filter((m) => m.realtimeInput?.text).map((m) => m.realtimeInput.text);
}

describe('opening a call', () => {
  it('says hello on a cold start', async () => {
    const { socket } = await openCall({});
    assert.equal(openerText(socket), GREETING_NUDGE);
  });

  it('opens a call that continues a chat thread, instead of waiting in silence', async () => {
    // The regression this covers: the thread note is realtimeInput, which is
    // context with no turn boundary. Sent alone it never made the model
    // generate, so a call resumed from a chat connected and then sat there
    // until the caller spoke first.
    const threadNote = 'Recent text thread:\nUser: work has been rough\nMindPal: tell me more';
    const { socket } = await openCall({ skipGreeting: true, threadNote });

    const opener = openerText(socket);
    assert.ok(opener.includes(threadNote), 'the thread still reaches the model');
    assert.ok(opener.endsWith(RESUME_NUDGE), 'and the same message asks for the first word');
  });

  it('opens with exactly one message, never a note racing the greeting', async () => {
    // Gemini treats `realtimeInput` as the caller speaking. A thread or clock
    // note sent separately at setup interrupted the greeting it preceded: one
    // trace shows `provider_interrupted` 75ms after setup and an opener that
    // came back with zero characters.
    const { socket } = await openCall({
      skipGreeting: true,
      threadNote: 'User: about yesterday',
      openingContext: '[[MindPal]] Local time about 9pm.',
    });
    assert.equal(noteTexts(socket).length, 0, 'no realtimeInput text at open');
    assert.equal(socket.sent.filter((m) => m.clientContent).length, 1);
    assert.match(openerText(socket), /Local time about 9pm/);
  });

  it('opens on the thread rather than with a generic hello', async () => {
    const { socket } = await openCall({ skipGreeting: true, threadNote: 'User: about yesterday' });
    assert.notEqual(openerText(socket), GREETING_NUDGE);
    assert.match(openerText(socket), /Do not greet as if you just met/);
  });

  it('holds the microphone while the opener is being generated', async () => {
    // Without the hold, room tone after connect reaches the provider before a
    // word is spoken and comes back as an interrupt against nothing playing.
    const { adapter } = await openCall({ skipGreeting: true, threadNote: 'User: hi' });
    assert.equal(adapter.isCaptureHeld, true);
    assert.ok(GREETING_HOLD_MS > 0);
  });

  it('does not open twice when a reconnect seeds a continuation', async () => {
    const { socket } = await openCall({ skipGreeting: true, continuation: 'We were mid-sentence.' });
    const openers = socket.sent.filter((message) => message.clientContent);
    assert.equal(openers.length, 1, 'a reconnect resumes once, it does not also greet');
    assert.equal(openerText(socket), 'We were mid-sentence.');
  });

  it('stays silent when a caller-facing greeting is genuinely not wanted', async () => {
    const { socket } = await openCall({ skipGreeting: true });
    assert.equal(socket.sent.filter((message) => message.clientContent).length, 0);
  });
});

describe('the opener survives an interrupt against silence', () => {
  /**
   * From a real trace:
   *   2188  setup.complete            <- hold armed for 2500ms
   *   2263  provider_interrupted      <- 75ms later, nothing playing
   *   4789  generation_complete {chars: 0}
   *   ...
   *  11926  "Hi. I'm MindPal..."      <- only after the reply watchdog rescued it
   *
   * The mic counters said `heldByGreeting: 4` - four frames, about 80ms, out of
   * the 125 the hold is meant to cover. The room then killed an opener that had
   * not made a sound yet.
   */
  it('keeps holding when the interrupt arrives before any audio', async () => {
    const { adapter, socket } = await openCall({});
    assert.equal(adapter.isCaptureHeld, true, 'armed at setup');

    socket.deliver({ serverContent: { interrupted: true } });
    await new Promise((resolve) => realSetTimeout(resolve, 0));

    assert.equal(adapter.isCaptureHeld, true, 'nothing had been said, so nothing was interrupted');
  });

  it('keeps holding while the opener is still playing, even through an interrupt', async () => {
    // The greeting is generated in ~0.5s but takes ~3s to play. Opening the mic
    // when generation finished let MindPal's own voice bleed back in, Gemini
    // heard "speech", and cut its greeting off mid-sentence. With the hold up,
    // the caller's mic is not being sent, so an interrupt here is echo.
    const { adapter, socket } = await openCall({});
    socket.deliver({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] },
      },
    });
    await new Promise((resolve) => realSetTimeout(resolve, 0));
    socket.deliver({ serverContent: { interrupted: true } });
    socket.deliver({ serverContent: { generationComplete: true } });
    await new Promise((resolve) => realSetTimeout(resolve, 0));

    assert.equal(adapter.isCaptureHeld, true, 'still playing, so still held');
  });

  it('releases the moment the session says the opener finished playing', async () => {
    const { adapter, socket } = await openCall({});
    socket.deliver({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] },
      },
    });
    await new Promise((resolve) => realSetTimeout(resolve, 0));
    adapter.openingFinished();
    assert.equal(adapter.isCaptureHeld, false);
  });

  it('ignores a "finished" before the opener has made a sound', async () => {
    const { adapter } = await openCall({});
    adapter.openingFinished();
    assert.equal(adapter.isCaptureHeld, true, 'playback idle before the greeting arrives is not the end of it');
  });

  it('does not let an empty generation end the hold either', async () => {
    const { adapter, socket } = await openCall({});
    socket.deliver({ serverContent: { generationComplete: true } });
    socket.deliver({ serverContent: { turnComplete: true } });
    await new Promise((resolve) => realSetTimeout(resolve, 0));

    assert.equal(adapter.isCaptureHeld, true, 'a generation that said nothing has not finished opening');
  });
});

describe('a greeting that came back empty is asked for again', () => {
  it('re-sends the opener once', async () => {
    const { adapter, socket } = await openCall({});
    assert.equal(socket.sent.filter((m) => m.clientContent).length, 1);
    assert.equal(adapter.retryOpener(), true);
    assert.equal(socket.sent.filter((m) => m.clientContent).length, 2, 'a second opener went out');
    assert.equal(adapter.isCaptureHeld, true, 'and the room is held off it again');
  });

  it('only once', async () => {
    const { adapter, socket } = await openCall({});
    adapter.retryOpener();
    assert.equal(adapter.retryOpener(), false);
    assert.equal(socket.sent.filter((m) => m.clientContent).length, 2);
  });

  it('never on a reconnect, which resumes rather than greets', async () => {
    const { adapter } = await openCall({ skipGreeting: true, continuation: 'We were mid-sentence.' });
    assert.equal(adapter.retryOpener(), false);
  });
});
