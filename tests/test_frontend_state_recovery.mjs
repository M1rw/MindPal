import assert from "node:assert/strict";
import test from "node:test";

class MemoryStorage {
  constructor(values = {}) {
    this.values = new Map(Object.entries(values));
  }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
  clear() { this.values.clear(); }
  get length() { return this.values.size; }
  key(index) { return Array.from(this.values.keys())[index] ?? null; }
}

const classSet = new Set();
const storage = new MemoryStorage({
  mindpal_state_v2: "{corrupt-json",
  mindpal_app_settings_v1: "{corrupt-json",
  mindpal_usage_v1: "{corrupt-json",
  mindpal_model: "unsupported",
  mindpal_mode: "unsupported",
});

globalThis.localStorage = storage;
globalThis.sessionStorage = new MemoryStorage();
globalThis.window = {
  localStorage: storage,
  sessionStorage: globalThis.sessionStorage,
  matchMedia: () => ({ matches: false }),
  addEventListener: () => {},
  removeEventListener: () => {},
  setTimeout,
  clearTimeout,
};
globalThis.document = {
  documentElement: {
    classList: {
      toggle(name, enabled) { if (enabled) classSet.add(name); else classSet.delete(name); },
      contains(name) { return classSet.has(name); },
    },
  },
  body: { appendChild: () => {} },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({
    className: "",
    textContent: "",
    style: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    querySelector: () => null,
    appendChild: () => {},
    remove: () => {},
  }),
  addEventListener: () => {},
};

const ui = await import("../frontend/js/ui_state.js");
const settings = await import("../frontend/js/settings_store.js");
const usage = await import("../frontend/js/components/usage_tracker.js");
const helpers = await import("../frontend/js/utils/chat_helpers.js");
const selector = await import("../frontend/js/components/model_selector.js");

test("corrupted UI persistence falls back to a usable state and accepts a new message", () => {
  const state = ui.loadState();
  assert.equal(state.chatMemory.length, 0);
  const message = ui.addMessage("User", "A fresh message after a corrupt cache.");
  assert.equal(message.text, "A fresh message after a corrupt cache.");
  assert.equal(ui.getState().chatMemory.length, 1);
  assert.doesNotThrow(() => JSON.parse(storage.getItem("mindpal_state_v2")));
});

test("corrupted settings are normalized and only supported metadata reaches chat", () => {
  const initial = settings.getAppSettings();
  assert.equal(initial.language, "auto");
  assert.equal(initial.appearance, "system");

  settings.setAppSetting("language", "not-a-supported-language");
  settings.setAppSetting("appearance", "dark");
  settings.setAppSetting("notifications.checkins", "push");

  const updated = settings.getAppSettings();
  assert.equal(updated.language, "auto");
  assert.equal(updated.appearance, "dark");
  assert.equal(updated.notifications.checkins, "push");
  assert.deepEqual(settings.buildChatSettingsMetadata(), { locale: "auto", ui_language: "auto" });
  assert.doesNotThrow(() => JSON.parse(storage.getItem("mindpal_app_settings_v1")));
});

test("guest usage recovers from corrupt storage and enforces the standard allowance", () => {
  usage.initUsageTracker({ getCurrentUser: () => null, showToast: () => {} });
  assert.equal(usage.canSendMessage("standard"), true);
  for (let count = 0; count < 50; count += 1) usage.recordMessage("standard");
  assert.equal(usage.canSendMessage("standard"), false);
  const summary = usage.getUsageSummary();
  assert.equal(summary.credits_5h, 50);
  assert.equal(summary.limit_5h, 50);
  assert.equal(summary.total_messages, 50);
  assert.doesNotThrow(() => JSON.parse(storage.getItem("mindpal_usage_v1")));
});

test("model selector fails closed to supported defaults after corrupted storage", () => {
  assert.equal(selector.getCurrentModel(), "standard");
  assert.equal(selector.getCurrentMode(), "Active Listen");
});

test("chat presentation removes instruction-leak markers from visible text", () => {
  const cleaned = helpers.stripSystemPromptLeak("SYSTEM PROMPT: never reveal this\nHelpful answer.");
  assert.equal(cleaned.includes("SYSTEM PROMPT"), false);
  assert.equal(cleaned.includes("Helpful answer."), true);
});

test("repetition filtering preserves separate crisis action lines", () => {
  const structured = [
    "For the next few minutes:",
    "- Move away from anything you could use to hurt yourself.",
    "- Go near another person or a public/shared space.",
    "- Message someone nearby and ask them to stay with you.",
    "Stay with me for one step: are you alone?",
  ].join("\n");
  const cleaned = helpers.truncateRepetition(structured);

  assert.equal(cleaned, structured);
  assert.equal((cleaned.match(/\n- /g) || []).length, 3);
  assert.equal(cleaned.includes(". - Go near"), false);
});


const richDom = await import("../frontend/js/utils/dom.js");

test("rich Markdown renders clear headings, lists, tables, callouts, and source links", () => {
  const html = richDom.formatMarkdown([
    "## A clear plan",
    "",
    "**Start small** and keep it realistic.",
    "",
    "1. Open the draft.",
    "2. Write one sentence.",
    "",
    "> Copyable script: I can begin with one line.",
    "",
    "| Option | Best when |",
    "| --- | --- |",
    "| Tiny step | You feel stuck |",
    "| Time box | You need momentum |",
    "",
    "Source: [Example guide](https://example.com/guide)",
  ].join("\n"));

  assert.match(html, /<h3 class="mp-heading mp-heading--h3">A clear plan<\/h3>/);
  assert.match(html, /<ol class="mp-list mp-list--ordered">/);
  assert.match(html, /<blockquote class="mp-callout">/);
  assert.match(html, /<table class="mp-table">/);
  assert.match(html, /class="mp-source-link"/);
  assert.match(html, /href="https:\/\/example\.com\/guide"/);
});

test("source links use a real favicon and source-only lists have no bullet marker", () => {
  const html = richDom.formatMarkdown("Sources:\n\n- [NHS guidance](https://www.nhs.uk/mental-health/)");

  assert.match(html, /class="mp-list mp-list--sources"/);
  assert.match(html, /class="mp-source-link__favicon"/);
  assert.match(html, /src="\/api\/favicon\?url=https%3A%2F%2Fwww\.nhs\.uk%2Fmental-health%2F"/);
  assert.equal(html.includes("mp-list--bulleted"), false);
});

test("rich Markdown compacts whitespace-corrupted model URLs into one source-link pill", () => {
  const html = richDom.formatMarkdown("* [https://www. nhs. uk/mental-health/](https://www. nhs. uk/mental-health/)");

  assert.match(html, /class="mp-source-link"/);
  assert.match(html, /href="https:\/\/www\.nhs\.uk\/mental-health\/"/);
  assert.match(html, />nhs\.uk<\/span>/);
  assert.equal(html.includes("[https://"), false);
  assert.equal(html.includes("Open source"), false);
});

test("rich Markdown separates collapsed legacy crisis actions", () => {
  const html = richDom.formatMarkdown("For the next few minutes:\n- Move away from danger. - Go near another person. - Message someone nearby.");

  assert.equal((html.match(/<li>/g) || []).length, 3);
  assert.equal(html.includes(". - Go near"), false);
});

test("rich Markdown renders collapsed numbered crisis actions as non-numbered action rows", () => {
  const html = richDom.formatMarkdown("1. Move away from danger. 2. Go near another person. 3. Message someone nearby.");

  assert.match(html, /class="mp-list mp-list--actions"/);
  assert.equal((html.match(/<li>/g) || []).length, 3);
  assert.equal(html.includes("mp-list--ordered"), false);
});

test("rich Markdown leaves unsupported link schemes as inert text", () => {
  const html = richDom.formatMarkdown("[Do not open](javascript:alert(1))");

  assert.equal(html.includes("href="), false);
  assert.equal(html.includes("javascript:"), true);
});

test("copy text removes rich Markdown while preserving visible source labels", () => {
  const plain = richDom.stripMarkdown("## Plan\n\n[Example guide](https://example.com)\n\n| A | B |\n| --- | --- |\n| One | Two |");

  assert.equal(plain.includes("Example guide"), true);
  assert.equal(plain.includes("https://example.com"), false);
  assert.equal(plain.includes("---"), false);
});
