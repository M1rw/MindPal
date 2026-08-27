import assert from "node:assert/strict";
import test from "node:test";

import {
  countUserMessages,
  createDefaultState,
  hydrateStoredState,
  normalizeStoredChatMemory,
} from "../frontend/js/state/app_state_model.js";

test("createDefaultState preserves the application state shape", () => {
  const state = createDefaultState({ createId: () => "fixed" });

  assert.deepEqual(state, {
    sessionId: "mp_fixed",
    chatMemory: [],
    streak: 0,
    lastVisitDate: null,
    visitHistory: [],
    crisisMode: true,
    cloudSyncEnabled: false,
    userName: "Friend",
    messageCount: 0,
  });
});

test("hydrateStoredState normalizes roles, limits text, and repairs invalid collections", () => {
  const state = hydrateStoredState({
    sessionId: "persisted",
    chatMemory: [
      { role: "user", content: "  hello  ", messageId: "m1" },
      { role: "assistant", text: "reply", messageId: "m2" },
      { role: "user", text: "", messageId: "ignored" },
    ],
    visitHistory: "not-an-array",
    crisisMode: false,
    userName: "  Alex  ",
  }, { createId: () => "test" });

  assert.equal(state.sessionId, "persisted");
  assert.deepEqual(state.chatMemory.map(({ role, text }) => ({ role, text })), [
    { role: "User", text: "hello" },
    { role: "MindPal", text: "reply" },
  ]);
  assert.deepEqual(state.visitHistory, []);
  assert.equal(state.crisisMode, false);
  assert.equal(state.userName, "Alex");
});

test("generated message identity accepts deterministic ID and clock providers", () => {
  const [message] = normalizeStoredChatMemory([{ role: "user", text: "new" }], {
    createId: () => "fixed",
    nowMs: () => 123,
    now: () => "2026-01-01T00:00:00.000Z",
  });

  assert.equal(message.messageId, "msg_fixed_123");
  assert.equal(message.createdAt, "2026-01-01T00:00:00.000Z");
});

test("normalizeStoredChatMemory retains only the newest bounded messages", () => {
  const messages = Array.from({ length: 260 }, (_, index) => ({
    role: "user",
    text: `message-${index}`,
    messageId: `m-${index}`,
  }));
  const normalized = normalizeStoredChatMemory(messages, { createId: () => "test" });

  assert.equal(normalized.length, 250);
  assert.equal(normalized[0].messageId, "m-10");
  assert.equal(normalized.at(-1).messageId, "m-259");
  assert.equal(countUserMessages(normalized), 250);
});
