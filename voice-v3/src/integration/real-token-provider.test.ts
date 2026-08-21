import { describe, expect, it, vi } from "vitest";
import { RealTokenProvider } from "./real-token-provider";

function tokenResponse(): Response {
  return new Response(JSON.stringify({
    token: "firebase-authenticated-voice-token",
    model: "gemini-2.5-flash-native-audio-dialog",
    websocket_url: "wss://generativelanguage.googleapis.com/ws",
    expires_at: Date.now() + 120_000,
    new_session_expires_at: Date.now() + 120_000,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("RealTokenProvider browser fetch binding", () => {
  it("invokes the default fetch with the global receiver", async () => {
    const originalFetch = globalThis.fetch;
    const receiverSensitiveFetch = vi.fn(function (this: typeof globalThis, input: RequestInfo | URL, init?: RequestInit) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      expect(input).toBe("/api/voice/token");
      expect(init?.credentials).toBe("same-origin");
      return Promise.resolve(tokenResponse());
    });
    globalThis.fetch = receiverSensitiveFetch as typeof fetch;

    try {
      const provider = new RealTokenProvider({
        getAuthToken: async () => "firebase-id-token",
        retryDelayMs: 0,
        maxAttempts: 1,
      });
      const token = await provider.getToken();

      expect(token.token).toBe("firebase-authenticated-voice-token");
      expect(receiverSensitiveFetch).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
