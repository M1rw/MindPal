import assert from "node:assert/strict";
import test from "node:test";

const { escapeHtml } = await import("../frontend/js/utils/html_escape.js");

test("escapeHtml encodes HTML metacharacters and handles nullish values", () => {
  assert.equal(
    escapeHtml(`<script>alert("x")</script> & 'quoted'`),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#039;quoted&#039;",
  );
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(42), "42");
});

test("invalid API response bodies are discarded without logging private content", async () => {
  const warnings = [];
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const previousConsoleWarn = console.warn;

  globalThis.window = {
    location: {
      hostname: "localhost",
      protocol: "http:",
      origin: "http://localhost:8000",
    },
    setTimeout,
    clearTimeout,
    MINDPAL_CONFIG: {},
  };
  globalThis.fetch = async () => new Response("private response body", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
  console.warn = (...args) => warnings.push(args);

  try {
    const { health } = await import(`../frontend/js/services/api.js?cleanup=${Date.now()}`);
    assert.equal(await health(), null);
    assert.deepEqual(warnings, []);
  } finally {
    console.warn = previousConsoleWarn;
    globalThis.fetch = previousFetch;
    globalThis.window = previousWindow;
  }
});
