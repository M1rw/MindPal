import assert from "node:assert/strict";
import test from "node:test";

function createScriptDocument() {
  const scripts = [];
  const document = {
    baseURI: "https://mindpal-demo.vercel.app/",
    head: {
      appendChild(script) {
        scripts.push(script);
        queueMicrotask(() => {
          globalThis.window.__MINDPAL_VOICE_RUNTIME__ = {
            createVoiceController() {
              return {
                startSession: async () => true,
                stopSession: async () => true,
                setMuted: () => false,
                setSpeakerMuted: () => false,
                sendTextToModel: () => false,
                getSessionState: () => ({ phase: "listening" }),
                getTranscriptSnapshot: () => ({ userTranscript: "", aiTranscript: "" }),
                getMicMuted: () => false,
                getAiSpeaking: () => false,
                getSpeakerMuted: () => false,
              };
            },
          };
          script.onload?.();
        });
      },
    },
    createElement(type) {
      assert.equal(type, "script");
      return {
        type: "",
        async: false,
        src: "",
        onload: null,
        onerror: null,
        attributes: new Map(),
        setAttribute(name, value) { this.attributes.set(name, value); },
        remove() { this.removed = true; },
      };
    },
    querySelector(selector) {
      return scripts.find((script) => !script.removed) ?? null;
    },
  };
  return { document, scripts };
}

test("production facade loads Voice through a native module script and exposes a controller", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const { document, scripts } = createScriptDocument();
  globalThis.window = {};
  globalThis.document = document;

  try {
    const facade = await import(`../frontend/js/voice_session.js?loader-test=${Date.now()}`);
    assert.equal(await facade.startSession(), true);
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].type, "module");
    assert.equal(scripts[0].async, true);
    assert.match(scripts[0].src, /^https:\/\/mindpal-demo\.vercel\.app\/voice\/assets\/runtime\.js\?v=voice-runtime-audio-gating-20260826$/);
    assert.equal(scripts[0].attributes.get("data-mindpal-voice-runtime"), "true");
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});
