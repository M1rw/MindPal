import assert from "node:assert/strict";
import test from "node:test";

if (!globalThis.window) {
  globalThis.window = {
    location: { hostname: "localhost", protocol: "http", origin: "http://localhost:8000" },
    setTimeout,
    clearTimeout,
  };
}

const {
  MindPalApiError,
  buildChatStreamPayload,
  sendChatMessageStream,
  shouldRetryStreamRequest,
} = await import("../frontend/js/services/api.js");

test("stream payload preserves a caller-owned client request ID and removes the optimistic user duplicate", () => {
  const payload = buildChatStreamPayload({
    message: "I need a little support.",
    history: [
      { role: "user", content: "I need a little support." },
      { role: "assistant", content: "I am here." },
      { role: "user", content: "I need a little support." },
    ],
    metadata: { locale: "en", mode: "active_listen" },
    clientRequestId: "chat_retry_123",
  });

  assert.equal(payload.message, "I need a little support.");
  assert.equal(payload.metadata.client_request_id, "chat_retry_123");
  assert.equal(payload.history.length, 2);
  assert.deepEqual(payload.history.at(-1), { role: "assistant", content: "I am here." });
});

test("stream retry is limited to a pre-output transient failure", () => {
  const networkError = new MindPalApiError("Network failed", { code: "network_error" });
  const timeoutError = new MindPalApiError("Timed out", { code: "request_timeout" });
  const serverError = new MindPalApiError("Server failed", { status: 500, code: "http_error" });

  assert.equal(shouldRetryStreamRequest({ error: networkError, emittedText: "", attempt: 0 }), true);
  assert.equal(shouldRetryStreamRequest({ error: timeoutError, emittedText: "", attempt: 0 }), true);
  assert.equal(shouldRetryStreamRequest({ error: networkError, emittedText: "partial response", attempt: 0 }), false);
  assert.equal(shouldRetryStreamRequest({ error: networkError, emittedText: "", attempt: 1 }), false);
  assert.equal(shouldRetryStreamRequest({ error: serverError, emittedText: "", attempt: 0 }), false);
  assert.equal(shouldRetryStreamRequest({ error: new DOMException("Cancelled", "AbortError"), emittedText: "", attempt: 0 }), false);
});

test("stream retries once before output and keeps the same idempotency key", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const chunks = [];
  const statuses = [];
  let callCount = 0;

  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    callCount += 1;
    if (callCount === 1) throw new TypeError("simulated network interruption");
    return new Response(
      [
        'data: {"text":"Recovered reply."}',
        "",
        'data: {"type":"status","status":"text_finished"}',
        "",
        'data: {"type":"metadata","request_id":"server-request"}',
        "",
      ].join("\n"),
      { headers: { "content-type": "text/event-stream" } },
    );
  };

  try {
    await sendChatMessageStream({
      message: "Please help me reset.",
      history: [],
      onChunk: (text) => chunks.push(text),
      onStatus: (status) => statuses.push(status),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0].metadata.client_request_id, calls[1].metadata.client_request_id);
  assert.match(calls[0].metadata.client_request_id, /^chat_/);
  assert.deepEqual(chunks, ["Recovered reply."]);
  assert.deepEqual(statuses, ["retrying", "text_finished"]);
});
