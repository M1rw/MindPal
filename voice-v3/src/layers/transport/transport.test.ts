import { describe, expect, it, vi } from "vitest";
import type { AudioFrame } from "../../core/layer-link";
import { base64ToBytes, bytesToBase64, int16ToBase64 } from "./base64-utils";
import {
  AudioFrameQueue,
  HARD_LIMIT,
  HIGH_WATERMARK,
  LOW_WATERMARK,
} from "./frame-queue";
import { WebSocketTransportManager, type WebSocketLike } from "./ws-manager";
import type { TokenProvider, VoiceToken } from "./token-provider";

class FakeSocket implements WebSocketLike {
  public readyState = 0;
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onclose: ((event: CloseEvent) => void) | null = null;
  public readonly sent: string[] = [];
  public closeCalls: Array<{ readonly code?: number; readonly reason?: string }> = [];

  public open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  public send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(data);
  }

  public close(code?: number, reason?: string): void {
    this.closeCalls.push({
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    });
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? "", wasClean: true } as CloseEvent);
  }

  public message(value: unknown): void {
    this.onmessage?.({ data: value } as MessageEvent<unknown>);
  }
}

class FixedTokenProvider implements TokenProvider {
  public constructor(private readonly token: VoiceToken) {}

  public async getToken(): Promise<VoiceToken> {
    return this.token;
  }
}

function createToken(): VoiceToken {
  return {
    token: "mock.jwt",
    model: "gemini-3.1-flash-live-preview",
    websocketUrl: "wss://example.test/live",
    expiresAt: 100_000,
    newSessionExpiresAt: 10_000,
  };
}

async function waitForAsyncToken(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function createFrame(sequence: number): AudioFrame {
  return {
    frameId: `frame-${sequence}`,
    sequence,
    sampleRate: 16_000,
    channels: 1,
    format: "pcm_s16le",
    data: new Int16Array([sequence, -sequence]).buffer,
    capturedAtMono: sequence,
    durationMs: 20,
    muted: false,
    rms: 0.1,
  };
}

describe("transport framing", () => {
  it("encodes PCM bytes in Base64 without changing their byte order", () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 254, 255]);
    const encoded = bytesToBase64(bytes);
    expect(encoded).toBe("AAECA/7/");
    expect(Array.from(base64ToBytes(encoded))).toEqual(Array.from(bytes));
    expect(int16ToBase64(new Int16Array([1, -2]))).toBe("AQD+/w==");
  });

  it("raises high pressure, evicts oldest frames at the hard limit, and lowers pressure after draining", () => {
    const signals: string[] = [];
    const queue = new AudioFrameQueue({
      onSignal: (signal) => signals.push(signal.type),
    });

    for (let sequence = 0; sequence <= HIGH_WATERMARK; sequence += 1) {
      queue.enqueue(createFrame(sequence));
    }
    expect(queue.size).toBe(HIGH_WATERMARK + 1);
    expect(signals).toContain("transport.backpressure.high");

    for (let sequence = HIGH_WATERMARK + 1; sequence <= HARD_LIMIT + 1; sequence += 1) {
      queue.enqueue(createFrame(sequence));
    }
    expect(queue.size).toBe(HARD_LIMIT);
    expect(signals).toContain("transport.frame.dropped");
    expect(queue.peek()?.sequence).toBe(2);

    while (queue.size > LOW_WATERMARK) queue.dequeue();
    expect(signals).toContain("transport.backpressure.low");
  });
});

describe("WebSocketTransportManager", () => {
  it("preserves Gemini auth token resource slashes in the WebSocket URL", async () => {
    const socket = new FakeSocket();
    let createdUrl = "";
    const manager = new WebSocketTransportManager({
      tokenProvider: new FixedTokenProvider({ ...createToken(), token: "authTokens/abc+123" }),
      webSocketFactory: (url) => {
        createdUrl = url;
        return socket;
      },
    });

    const connection = manager.connect();
    await waitForAsyncToken();
    expect(createdUrl).toBe("wss://example.test/live?access_token=authTokens/abc%2B123");
    socket.open();
    socket.message(JSON.stringify({ setupComplete: {} }));
    await connection;
    manager.close();
  });

  it("accepts null-valued setupComplete from JSON empty-message transcoding", async () => {
    const socket = new FakeSocket();
    const manager = new WebSocketTransportManager({
      tokenProvider: new FixedTokenProvider(createToken()),
      webSocketFactory: () => socket,
    });

    const connection = manager.connect();
    await waitForAsyncToken();
    socket.open();
    socket.message(JSON.stringify({ setupComplete: null }));

    await connection;
    expect(manager.isReady).toBe(true);
    manager.close();
  });

  it("sends the exact Gemini 3.1 setup only after socket open and becomes ready after setupComplete", async () => {
    const socket = new FakeSocket();
    const events: string[] = [];
    const manager = new WebSocketTransportManager({
      tokenProvider: new FixedTokenProvider(createToken()),
      webSocketFactory: () => socket,
      nowMono: () => 1_000,
      setupTimeoutMs: 5_000,
      onEvent: (event) => events.push(event.type),
    });

    const connection = manager.connect();
    await waitForAsyncToken();
    expect(manager.state).toBe("CONNECTING");
    expect(socket.sent).toHaveLength(0);

    socket.open();
    expect(socket.sent).toHaveLength(1);
    const setup = JSON.parse(socket.sent[0] ?? "{}");
    expect(setup).toEqual({
      setup: {
        model: "models/gemini-3.1-flash-live-preview",
        generationConfig: {
          responseModalities: ["AUDIO"],
        },
        systemInstruction: {
          parts: [{ text: "You are MindPal. Use the configured Gemini Native Audio voice consistently. Stay in an active listening conversation: do not interrupt user speech, but during an approved natural pause you may produce one brief context-appropriate acknowledgement such as “mhm”, “yeah”, “I hear you”, or “go on”. When the application sends a VOICE_CUE_REQUEST, produce only the requested short acknowledgement in this same voice; do not explain the instruction, answer the topic, or start a second full response." }],
        },
        sessionResumption: {},
      },
    });
    expect(manager.state).toBe("CONNECTING");

    socket.message(
      JSON.stringify({
        setupComplete: {},
        sessionResumptionUpdate: { resumable: true, newHandle: "resume-1" },
      }),
    );
    await connection;
    expect(manager.state).toBe("OPEN");
    expect(manager.isReady).toBe(true);
    expect(manager.getSessionResumptionHandle()).toBe("resume-1");
    expect(events).toContain("transport.socket.opened");
    expect(events).toContain("transport.setup.complete");
    manager.close();
  });

  it("emits socket error and close lifecycle metadata without exposing credentials", async () => {
    const socket = new FakeSocket();
    const lifecycle: Array<Record<string, unknown>> = [];
    const manager = new WebSocketTransportManager({
      tokenProvider: new FixedTokenProvider(createToken()),
      webSocketFactory: () => socket,
      onEvent: (event) => {
        if (event.type === "transport.socket.opened" || event.type === "transport.socket.error" || event.type === "transport.socket.closed") {
          lifecycle.push(event);
        }
      },
    });

    const connection = manager.connect();
    await waitForAsyncToken();
    socket.open();
    socket.message(JSON.stringify({ setupComplete: true }));
    await connection;
    socket.onerror?.(new Event("error"));
    socket.close(1008, "policy violation with authTokens/secret");

    expect(lifecycle).toEqual([
      { type: "transport.socket.opened", readyState: 1 },
      { type: "transport.socket.error", readyState: 1 },
      { type: "transport.socket.closed", code: 1008, reason: "policy violation with authTokens/<redacted>", wasClean: true },
    ]);
  });

  it("reconnects with the fallback token after a primary setup timeout", async () => {
    const primarySocket = new FakeSocket();
    const fallbackSocket = new FakeSocket();
    const sockets = [primarySocket, fallbackSocket];
    const provider: TokenProvider = {
      async getToken() { return createToken(); },
      async getFallbackToken() {
        return {
          ...createToken(),
          token: "fallback.jwt",
          model: "gemini-2.5-flash-native-audio-preview-12-2025",
        };
      },
    };
    const manager = new WebSocketTransportManager({
      tokenProvider: provider,
      webSocketFactory: () => sockets.shift() ?? new FakeSocket(),
      setupTimeoutMs: 5,
    });

    const primaryConnection = manager.connect();
    await waitForAsyncToken();
    primarySocket.open();
    await expect(primaryConnection).rejects.toThrow("Gemini setupComplete timeout");
    expect(primarySocket.closeCalls.length).toBeGreaterThan(0);

    const fallbackConnection = manager.connectFallback();
    await waitForAsyncToken();
    fallbackSocket.open();
    fallbackSocket.message(JSON.stringify({ setupComplete: {} }));
    await fallbackConnection;

    expect(manager.isReady).toBe(true);
    expect(manager.snapshot.ready).toBe(true);
    manager.close();
  });

  it("omits unsupported thinking configuration for fallback models", async () => {
    const socket = new FakeSocket();
    const manager = new WebSocketTransportManager({
      tokenProvider: new FixedTokenProvider({
        ...createToken(),
        model: "gemini-2.5-flash-native-audio-preview-12-2025",
      }),
      webSocketFactory: () => socket,
    });
    const connection = manager.connect();
    await waitForAsyncToken();
    socket.open();
    const setup = JSON.parse(socket.sent[0] ?? "{}");
    expect(setup.setup.generationConfig.thinkingConfig).toBeUndefined();
    socket.message(JSON.stringify({ setupComplete: {} }));
    await connection;
    manager.close();
  });

  it("surfaces a Gemini server error instead of waiting for setup timeout", async () => {
    const socket = new FakeSocket();
    const manager = new WebSocketTransportManager({
      tokenProvider: new FixedTokenProvider(createToken()),
      webSocketFactory: () => socket,
      setupTimeoutMs: 5_000,
    });
    const connection = manager.connect();
    await waitForAsyncToken();
    socket.open();
    socket.message(JSON.stringify({ error: { code: 3, message: "Invalid setup field" } }));
    await expect(connection).rejects.toThrow("Gemini server error: Invalid setup field");
    expect(manager.state).toBe("CLOSED");
  });

  it("uses provider-default voice and sends a bounded native cue request", async () => {
    const socket = new FakeSocket();
    const manager = new WebSocketTransportManager({
      tokenProvider: new FixedTokenProvider(createToken()),
      webSocketFactory: () => socket,
      voicePersona: "Charon",
    });
    const connection = manager.connect();
    await waitForAsyncToken();
    socket.open();
    const setup = JSON.parse(socket.sent[0] ?? "{}");
    expect(setup.setup.generationConfig.speechConfig).toBeUndefined();
    socket.message(JSON.stringify({ setupComplete: true }));
    await connection;
    expect(manager.sendRealtimeText("VOICE_CUE_REQUEST: mhm")).toBe(true);
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toEqual({ realtimeInput: { text: "VOICE_CUE_REQUEST: mhm" } });
    manager.close();
  });

  it("injects bounded local memory into setup before the socket is opened", async () => {
    const socket = new FakeSocket();
    let contextCalls = 0;
    const manager = new WebSocketTransportManager({
      tokenProvider: new FixedTokenProvider(createToken()),
      webSocketFactory: () => socket,
      getSetupContext: async () => {
        contextCalls += 1;
        return "User context from previous sessions:\\n- User name is Marwan.";
      },
    });
    const connection = manager.connect();
    await waitForAsyncToken();
    expect(contextCalls).toBe(1);
    expect(socket.sent).toHaveLength(0);
    socket.open();
    const setup = JSON.parse(socket.sent[0] ?? "{}");
    expect(setup.setup.systemInstruction.parts).toEqual([
      { text: expect.stringContaining("You are MindPal.") },
      { text: "User context from previous sessions:\\n- User name is Marwan." },
    ]);
    socket.message(JSON.stringify({ setupComplete: true }));
    await connection;
    manager.close();
  });

  it("queues capture audio before setup, flushes it after readiness, and frames it as Gemini realtime input", async () => {
    const socket = new FakeSocket();
    const manager = new WebSocketTransportManager({
      tokenProvider: new FixedTokenProvider(createToken()),
      webSocketFactory: () => socket,
      nowMono: () => 1_000,
    });
    const connection = manager.connect();
    await waitForAsyncToken();
    const accepted = manager.sendAudioFrame(createFrame(7));
    expect(accepted).toBe(true);
    expect(manager.snapshot.queueDepth).toBe(1);
    expect(socket.sent).toHaveLength(0);

    socket.open();
    socket.message(JSON.stringify({ setupComplete: true }));
    await connection;

    expect(socket.sent).toHaveLength(2);
    const audioPayload = JSON.parse(socket.sent[1] ?? "{}");
    expect(audioPayload.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
    expect(audioPayload.realtimeInput.audio.data).toBe("BwD5/w==");
    expect(manager.snapshot).toMatchObject({ framesSent: 1, queueDepth: 0, bytesSent: expect.any(Number) });
    manager.close();
  });

  it("sends keepalive after ten seconds without traffic", async () => {
    const socket = new FakeSocket();
    let now = 1_000;
    const timers: Array<() => void> = [];
    const keepaliveEvents: string[] = [];
    const manager = new WebSocketTransportManager({
      tokenProvider: new FixedTokenProvider(createToken()),
      webSocketFactory: () => socket,
      nowMono: () => now,
      setTimer: (callback) => {
        timers.push(callback);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: vi.fn(),
      onEvent: (event) => keepaliveEvents.push(event.type),
    });
    const connection = manager.connect();
    await waitForAsyncToken();
    socket.open();
    socket.message(JSON.stringify({ setupComplete: true }));
    await connection;
    const sentBefore = socket.sent.length;
    now = 12_000;
    timers.at(-1)?.();
    expect(socket.sent.length).toBe(sentBefore + 1);
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toEqual({ keepalive: {} });
    expect(keepaliveEvents).toContain("transport.keepalive.sent");
    manager.close();
  });

  it("sends prosody context notes as active-session realtimeInput text, not clientContent", async () => {
    const socket = new FakeSocket();
    const manager = new WebSocketTransportManager({
      tokenProvider: new FixedTokenProvider(createToken()),
      webSocketFactory: () => socket,
      nowMono: () => 1_000,
    });
    const connection = manager.connect();
    await waitForAsyncToken();
    socket.open();
    socket.message(JSON.stringify({ setupComplete: true }));
    await connection;

    expect(manager.sendRealtimeText("User sounds urgent. Respond concisely and calmly.")).toBe(true);
    const contextPayload = JSON.parse(socket.sent[1] ?? "{}");
    expect(contextPayload).toEqual({
      realtimeInput: {
        text: "User sounds urgent. Respond concisely and calmly.",
      },
    });
    expect(contextPayload.clientContent).toBeUndefined();
    manager.close();
  });

  it("rejects new audio after close and never sends on the closed socket", async () => {
    const socket = new FakeSocket();
    const manager = new WebSocketTransportManager({
      tokenProvider: new FixedTokenProvider(createToken()),
      webSocketFactory: () => socket,
      nowMono: () => 1_000,
    });
    const connection = manager.connect();
    await waitForAsyncToken();
    socket.open();
    socket.message(JSON.stringify({ setupComplete: true }));
    await connection;
    manager.close();

    expect(manager.state).toBe("CLOSED");
    expect(manager.sendAudioFrame(createFrame(99))).toBe(false);
    expect(socket.sent).toHaveLength(1);
  });
});
