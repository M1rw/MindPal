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
  it("uses the primary response fallback grant for a second token request", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          token: "primary-token",
          model: "gemini-3.1-flash-live-preview",
          websocket_url: "wss://generativelanguage.googleapis.com/ws/constrained",
          expires_at: Date.now() + 120_000,
          new_session_expires_at: Date.now() + 120_000,
          fallback_grant: "fallback-grant-opaque",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        token: "fallback-token",
        model: "gemini-2.5-flash-native-audio-preview-12-2025",
        websocket_url: "wss://generativelanguage.googleapis.com/ws/constrained",
        expires_at: Date.now() + 120_000,
        new_session_expires_at: Date.now() + 120_000,
        fallback_used: true,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const provider = new RealTokenProvider({
      fetchImpl,
      getAuthToken: async () => "firebase-id-token",
      retryDelayMs: 0,
      maxAttempts: 1,
    });

    const primary = await provider.getToken();
    const fallback = await provider.getFallbackToken?.();

    expect(primary.model).toBe("gemini-3.1-flash-live-preview");
    expect(fallback?.model).toBe("gemini-2.5-flash-native-audio-preview-12-2025");
    expect(requests).toEqual([
      "/api/voice/token",
      "/api/voice/token?fallback_grant=fallback-grant-opaque",
    ]);
  });

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
