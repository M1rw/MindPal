import type { WebSocketFactory, WebSocketLike } from "../layers/transport/ws-manager";
import {
  MockTokenProvider,
  type MockTokenProviderOptions,
  type TokenProvider,
} from "../layers/transport/token-provider";

export type MockProviderState = "IDLE" | "CONNECTED" | "CLOSED";

type MockSocket = WebSocketLike & {
  readonly server: MockGeminiServer;
  readonly sentMessages: string[];
  open(): void;
  deliver(message: unknown): void;
};

export class MockGeminiServer {
  private readonly sockets = new Set<MockSocket>();
  private readonly tokenProviderValue: TokenProvider;
  private speechFrameCount = 0;
  private responseCounter = 0;
  private greeted = false;
  private userResponseEmitted = false;
  private stateValue: MockProviderState = "IDLE";
  private lastSocket: MockSocket | null = null;

  public constructor(options: { readonly nowMono?: () => number } = {}) {
    const tokenOptions: MockTokenProviderOptions = options.nowMono
      ? { websocketUrl: "wss://mock-gemini.local/live", nowMono: options.nowMono }
      : { websocketUrl: "wss://mock-gemini.local/live" };
    this.tokenProviderValue = new MockTokenProvider(tokenOptions);
  }

  public get tokenProvider(): TokenProvider {
    return this.tokenProviderValue;
  }

  public get state(): MockProviderState {
    return this.stateValue;
  }

  public get receivedAudioFrames(): number {
    return this.speechFrameCount;
  }

  public createWebSocketFactory(): WebSocketFactory {
    return () => {
      const socket = createMockSocket(this);
      this.sockets.add(socket);
      this.lastSocket = socket;
      return socket;
    };
  }

  public simulateUserSpeech(frameCount = 150): void {
    const socket = this.requireSocket();
    for (let index = 0; index < frameCount; index += 1) {
      socket.send(JSON.stringify({
        realtimeInput: {
          audio: {
            data: "AAAA",
            mimeType: "audio/pcm;rate=16000",
          },
        },
      }));
    }
  }

  public simulateInterruption(): void {
    const socket = this.requireSocket();
    const responseId = `response-${++this.responseCounter}`;
    socket.deliver({
      serverContent: {
        turnId: "turn-1",
        providerResponseId: responseId,
        interrupted: true,
      },
    });
    socket.deliver(this.responseMessage(
      "I heard you. I’ll follow your new direction.",
      responseId,
      "turn-1",
      false,
    ));
  }

  public simulateTurnComplete(): void {
    const socket = this.requireSocket();
    socket.deliver({
      serverContent: {
        turnId: "turn-1",
        providerResponseId: `response-${this.responseCounter || 1}`,
        turnComplete: true,
      },
    });
  }

  public close(): void {
    for (const socket of this.sockets) socket.close(1000, "mock server stopped");
    this.sockets.clear();
    this.lastSocket = null;
    this.stateValue = "CLOSED";
  }

  private handleClientMessage(socket: MockSocket, raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (isSetupMessage(message)) {
      this.stateValue = "CONNECTED";
      socket.deliver({ setupComplete: true });
      if (!this.greeted) {
        this.greeted = true;
        socket.deliver(this.responseMessage("Hi, I’m here with you. What’s on your mind?", "greeting-response", null, true));
      }
      return;
    }
    if (isGreetingCommand(message)) {
      if (!this.greeted) {
        this.greeted = true;
        socket.deliver(this.responseMessage("Hi, I’m here with you. What’s on your mind?", "greeting-response", null, true));
      }
      return;
    }
    const cueText = readNativeCueText(message);
    if (cueText) {
      const responseId = `cue-response-${++this.responseCounter}`;
      socket.deliver(this.responseMessage(cueText, responseId, "turn-1", true));
      return;
    }
    if (isAudioMessage(message)) {
      this.speechFrameCount += 1;
      if (this.speechFrameCount >= 150 && !this.userResponseEmitted) {
        this.userResponseEmitted = true;
        const responseId = `response-${++this.responseCounter}`;
        socket.deliver({
          serverContent: {
            turnId: "turn-1",
            inputAudioTranscription: {
              text: "I want to tell you what happened today.",
              isFinal: true,
              cumulative: true,
            },
          },
        });
        socket.deliver(this.responseMessage(
          "I’m listening. Please continue.",
          responseId,
          "turn-1",
          false,
        ));
      }
    }
  }

  private responseMessage(text: string, responseId: string, turnId: string | null, complete: boolean): unknown {
    return {
      serverContent: {
        ...(turnId ? { turnId } : {}),
        providerResponseId: responseId,
        modelTurn: {
          parts: [
            { text, isFinal: complete, cumulative: true },
            { inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAAAAA==" } },
          ],
        },
        ...(complete ? { turnComplete: true } : {}),
      },
    };
  }

  private requireSocket(): MockSocket {
    if (!this.lastSocket || this.lastSocket.readyState !== 1) {
      throw new Error("MockGeminiServer is not connected");
    }
    return this.lastSocket;
  }

  public _handleClientMessage(socket: MockSocket, raw: string): void {
    this.handleClientMessage(socket, raw);
  }

  public _markClosed(socket: MockSocket): void {
    this.sockets.delete(socket);
    if (this.lastSocket === socket) this.lastSocket = null;
    if (this.sockets.size === 0) this.stateValue = "CLOSED";
  }
}

function createMockSocket(server: MockGeminiServer): MockSocket {
  const socket: MockSocket = {
    server,
    sentMessages: [],
    readyState: 0,
    binaryType: "arraybuffer",
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    open() {
      (this as { readyState: number }).readyState = 1;
      this.onopen?.(new Event("open"));
    },
    deliver(message) {
      this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent<string>);
    },
    send(data: string) {
      this.sentMessages.push(data);
      server._handleClientMessage(this, data);
    },
    close(code = 1000, reason = "closed") {
      (this as { readyState: number }).readyState = 3;
      server._markClosed(this);
      this.onclose?.({ code, reason } as CloseEvent);
    },
  };
  queueMicrotask(() => socket.open());
  return socket;
}

function isSetupMessage(value: unknown): boolean {
  return isRecord(value) && isRecord(value.setup);
}

function isGreetingCommand(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.realtimeInput)) return false;
  const text = value.realtimeInput.text;
  return typeof text === "string" && text.includes("greeting");
}

function isAudioMessage(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.realtimeInput)) return false;
  return isRecord(value.realtimeInput.audio);
}

function readNativeCueText(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.realtimeInput)) return null;
  const text = value.realtimeInput.text;
  if (typeof text !== "string" || !text.startsWith("VOICE_CUE_REQUEST:")) return null;
  const cue = text.slice("VOICE_CUE_REQUEST:".length).trim();
  return cue ? cue.slice(0, 80) : null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
