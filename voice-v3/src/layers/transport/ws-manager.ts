import type { AudioFrame } from "../../core/layer-link";
import { AudioFrameQueue, type FrameQueueSignal } from "./frame-queue";
import { int16ToBase64 } from "./base64-utils";
import type { TokenProvider, VoiceToken } from "./token-provider";
import { DEBUG_V3 } from "../../debug/debug-flags";

export const DEBUG_TRANSPORT = DEBUG_V3;
export const TRANSPORT_KEEPALIVE_MS = 10_000;
export const TRANSPORT_SETUP_TIMEOUT_MS = 15_000;

export type TransportState =
  | "IDLE"
  | "CONNECTING"
  | "OPEN"
  | "CLOSING"
  | "CLOSED"
  | "RECONNECTING";

export type TransportEvent =
  | { readonly type: "transport.state.changed"; readonly state: TransportState }
  | { readonly type: "transport.setup.sent"; readonly model: string }
  | { readonly type: "transport.setup.complete"; readonly handle: string | null }
  | { readonly type: "transport.backpressure.high"; readonly depth: number }
  | { readonly type: "transport.backpressure.low"; readonly depth: number }
  | {
      readonly type: "transport.frame.dropped";
      readonly sequence: number;
      readonly depth: number;
      readonly reason: "hard-limit";
    }
  | { readonly type: "transport.keepalive.sent" }
  | { readonly type: "transport.error"; readonly reason: string; readonly error?: unknown }
  | { readonly type: "transport.message.received"; readonly messageType: string };

export type TransportSnapshot = {
  readonly state: TransportState;
  readonly ready: boolean;
  readonly queueDepth: number;
  readonly queueCapacity: number;
  readonly framesSent: number;
  readonly framesDropped: number;
  readonly bytesSent: number;
  readonly resumptionHandle: string | null;
  readonly lastSentAtMono: number;
  readonly setupSent: boolean;
};

export type WebSocketLike = {
  readonly readyState: number;
  binaryType?: BinaryType;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type WebSocketFactory = (url: string) => WebSocketLike;

export type WsManagerOptions = {
  readonly tokenProvider: TokenProvider;
  readonly webSocketFactory?: WebSocketFactory;
  readonly nowMono?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly keepaliveMs?: number;
  readonly setupTimeoutMs?: number;
  readonly onProviderMessage?: (message: unknown) => void;
  readonly voicePersona?: string;
  readonly getSetupContext?: () => Promise<string | null>;
  readonly onEvent?: (event: TransportEvent) => void;
  readonly onSnapshot?: (snapshot: TransportSnapshot) => void;
};

const SOCKET_OPEN = 1;

/**
 * Transport Layer boundary for Gemini Live. It owns socket lifecycle, setup,
 * framing, bounded audio buffering, and transport telemetry. It never sends
 * while CLOSING or CLOSED, even if an old capture callback fires late.
 */
export class WebSocketTransportManager {
  private readonly tokenProvider: TokenProvider;
  private readonly webSocketFactory: WebSocketFactory;
  private readonly nowMono: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly keepaliveMs: number;
  private readonly setupTimeoutMs: number;
  private readonly onProviderMessage: ((message: unknown) => void) | undefined;
  private readonly voicePersona: string;
  private readonly getSetupContext: (() => Promise<string | null>) | undefined;
  private readonly onEvent: ((event: TransportEvent) => void) | undefined;
  private readonly onSnapshot: ((snapshot: TransportSnapshot) => void) | undefined;
  private readonly queue: AudioFrameQueue;

  private transportState: TransportState = "IDLE";
  private socket: WebSocketLike | null = null;
  private token: VoiceToken | null = null;
  private setupSent = false;
  private setupComplete = false;
  private resumptionHandle: string | null = null;
  private lastSentAtMono = 0;
  private framesSent = 0;
  private framesDropped = 0;
  private bytesSent = 0;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private setupTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((error: Error) => void) | null = null;
  private closingByUser = false;
  private setupContext: string | null = null;

  public constructor(options: WsManagerOptions) {
    this.tokenProvider = options.tokenProvider;
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.nowMono = options.nowMono ?? (() => performance.now());
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.keepaliveMs = options.keepaliveMs ?? TRANSPORT_KEEPALIVE_MS;
    this.setupTimeoutMs = options.setupTimeoutMs ?? TRANSPORT_SETUP_TIMEOUT_MS;
    this.onProviderMessage = options.onProviderMessage;
    this.voicePersona = options.voicePersona?.trim() || "Kore";
    this.getSetupContext = options.getSetupContext;
    this.onEvent = options.onEvent;
    this.onSnapshot = options.onSnapshot;
    this.queue = new AudioFrameQueue({
      onSignal: (signal) => this.handleQueueSignal(signal),
    });
  }

  public async connect(): Promise<void> {
    if (this.transportState === "OPEN") return;
    if (this.connectPromise) return this.connectPromise;

    this.closingByUser = false;
    this.setState(this.transportState === "RECONNECTING" ? "RECONNECTING" : "CONNECTING");
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });

    try {
      this.token = await this.tokenProvider.getToken();
      this.setupContext = this.getSetupContext ? await this.getSetupContext() : null;
      if (this.transportState === "CLOSING" || this.transportState === "CLOSED") {
        throw new Error("transport closed while acquiring token");
      }
      const url = appendAccessToken(this.token.websocketUrl, this.token.token);
      this.socket = this.webSocketFactory(url);
      this.attachSocketHandlers(this.socket);
      this.startSetupTimeout();
      this.debug("[Transport] socket created", { url: redactToken(url) });
    } catch (error) {
      this.failConnect(toError(error, "transport connection failed"));
    }

    return this.connectPromise;
  }

  public async reconnect(): Promise<void> {
    if (this.transportState === "CLOSING") return;
    const oldSocket = this.socket;
    this.clearHeartbeat();
    this.clearSetupTimer();
    this.socket = null;
    oldSocket?.close(1000, "reconnect");
    this.setState("RECONNECTING");
    this.connectPromise = null;
    this.resolveConnect = null;
    this.rejectConnect = null;
    await this.connect();
  }

  public close(code = 1000, reason = "client close"): void {
    this.closingByUser = true;
    this.clearHeartbeat();
    this.clearSetupTimer();
    const socket = this.socket;
    if (socket && socket.readyState !== 3) {
      this.setState("CLOSING");
      socket.close(code, reason);
    } else {
      this.clearSocketAndTimers();
      this.setState("CLOSED");
      this.rejectPendingConnect(new Error(reason));
    }
    this.queue.clear();
    this.emitSnapshot();
  }

  public sendAudioFrame(frame: AudioFrame): boolean {
    if (!isValidAudioFrame(frame)) {
      this.emit({ type: "transport.error", reason: "invalid audio frame" });
      return false;
    }
    if (this.transportState === "CLOSING" || this.transportState === "CLOSED") {
      this.debug("[Transport] audio rejected after close", { sequence: frame.sequence });
      return false;
    }
    this.queue.enqueue(frame);
    this.flushQueue();
    this.emitSnapshot();
    return true;
  }

  public sendControl(payload: unknown): boolean {
    if (!this.canSend()) return false;
    return this.sendJson({ realtimeInput: { text: JSON.stringify(payload) } });
  }

  /** Sends a bounded plain-text update through Gemini Live’s active-session realtime input path. */
  public sendRealtimeText(text: string): boolean {
    const normalized = text.trim().slice(0, 400);
    if (!normalized || !this.canSend()) return false;
    return this.sendJson({ realtimeInput: { text: normalized } });
  }

  public get state(): TransportState {
    return this.transportState;
  }

  public get isReady(): boolean {
    return this.transportState === "OPEN" && this.setupComplete;
  }

  public get snapshot(): TransportSnapshot {
    return {
      state: this.transportState,
      ready: this.isReady,
      queueDepth: this.queue.size,
      queueCapacity: this.queue.capacity,
      framesSent: this.framesSent,
      framesDropped: this.framesDropped,
      bytesSent: this.bytesSent,
      resumptionHandle: this.resumptionHandle,
      lastSentAtMono: this.lastSentAtMono,
      setupSent: this.setupSent,
    };
  }

  public getSessionResumptionHandle(): string | null {
    return this.resumptionHandle;
  }

  private attachSocketHandlers(socket: WebSocketLike): void {
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      if (socket !== this.socket || this.transportState === "CLOSING" || this.transportState === "CLOSED") {
        return;
      }
      this.sendSetup();
    };
    socket.onmessage = (event) => {
      if (socket !== this.socket) return;
      this.handleIncoming(event.data);
    };
    socket.onerror = (event) => {
      if (socket !== this.socket) return;
      this.emit({ type: "transport.error", reason: "WebSocket error", error: event });
    };
    socket.onclose = (event) => {
      if (socket !== this.socket) return;
      this.clearSocketAndTimers();
      this.setState("CLOSED");
      const error = new Error(`WebSocket closed: ${event.code} ${event.reason || ""}`.trim());
      if (!this.closingByUser) this.rejectPendingConnect(error);
      this.emitSnapshot();
    };
  }

  private sendSetup(): void {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN || !this.token) return;
    const model = this.token.model.startsWith("models/") ? this.token.model : `models/${this.token.model}`;
    const setup = {
      setup: {
        model,
        generationConfig: {
          responseModalities: ["AUDIO"],
          thinkingConfig: { thinkingLevel: "minimal" },
        },
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: this.voicePersona,
            },
          },
        },
        systemInstruction: {
          parts: [
            {
              text: `You are MindPal. Use the configured Gemini Native Audio voice consistently. Stay in an active listening conversation: do not interrupt user speech, but during an approved natural pause you may produce one brief context-appropriate acknowledgement such as “mhm”, “yeah”, “I hear you”, or “go on”. When the application sends a VOICE_CUE_REQUEST, produce only the requested short acknowledgement in this same voice; do not explain the instruction, answer the topic, or start a second full response.`,
            },
            ...(this.setupContext ? [{ text: this.setupContext }] : []),
          ],
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            prefixPaddingMs: 100,
            silenceDurationMs: 500,
          },
        },
        sessionResumption: {},
        ...(this.setupContext ? { systemInstruction: { parts: [{ text: this.setupContext }] } } : {}),
      },
    };
    this.setupSent = true;
    this.sendJson(setup, true);
    this.emit({ type: "transport.setup.sent", model });
    this.debug("[Transport] -> [Gemini] setup", setup);
  }

  private handleIncoming(raw: unknown): void {
    const message = parseIncoming(raw);
    const binary = isBinaryPayload(raw);
    if (message === null && !binary) {
      this.emit({ type: "transport.error", reason: "invalid WebSocket JSON message" });
      return;
    }
    const messageType = message ? findMessageType(message) : "binary";
    this.emit({ type: "transport.message.received", messageType });
    this.debug("[Gemini] -> [Transport] message", raw);
    this.onProviderMessage?.(raw);

    if (!message) return;
    const handle = readResumptionHandle(message);
    if (handle) this.resumptionHandle = handle;

    if (isSetupComplete(message)) {
      this.setupComplete = true;
      this.setState("OPEN");
      this.clearSetupTimer();
      this.resolvePendingConnect();
      this.emit({ type: "transport.setup.complete", handle: this.resumptionHandle });
      this.flushQueue();
      this.startHeartbeat();
      this.emitSnapshot();
    }
  }

  private flushQueue(): void {
    if (!this.canSend()) return;
    let frame = this.queue.dequeue();
    while (frame && this.canSend()) {
      const payload = {
        realtimeInput: {
          audio: {
            data: int16ToBase64(frame.data),
            mimeType: "audio/pcm;rate=16000",
          },
        },
      };
      if (!this.sendJson(payload)) return;
      this.framesSent += 1;
      frame = this.queue.dequeue();
    }
    this.emitSnapshot();
  }

  private sendJson(payload: unknown, allowDuringSetup = false): boolean {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) return false;
    if (!allowDuringSetup && !this.canSend()) return false;
    if (this.transportState === "CLOSING" || this.transportState === "CLOSED") return false;
    const encoded = JSON.stringify(payload);
    this.socket.send(encoded);
    this.lastSentAtMono = this.nowMono();
    this.bytesSent += new TextEncoder().encode(encoded).byteLength;
    this.debug("[Transport] -> [Gemini] JSON", payload);
    return true;
  }

  private canSend(): boolean {
    return this.transportState === "OPEN" && this.setupComplete && this.socket?.readyState === SOCKET_OPEN;
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    const tick = () => {
      if (this.transportState !== "OPEN") return;
      if (this.nowMono() - this.lastSentAtMono >= this.keepaliveMs) {
        if (this.sendJson({ keepalive: {} })) {
          this.emit({ type: "transport.keepalive.sent" });
        }
      }
      this.heartbeatTimer = this.setTimer(tick, Math.min(this.keepaliveMs, 1_000));
    };
    this.heartbeatTimer = this.setTimer(tick, Math.min(this.keepaliveMs, 1_000));
  }

  private startSetupTimeout(): void {
    this.clearSetupTimer();
    this.setupTimer = this.setTimer(() => {
      if (!this.setupComplete) {
        this.failConnect(new Error("Gemini setupComplete timeout"));
        this.close(1000, "setup timeout");
      }
    }, this.setupTimeoutMs);
  }

  private handleQueueSignal(signal: FrameQueueSignal): void {
    if (signal.type === "transport.frame.dropped") {
      this.framesDropped += 1;
      this.emit({
        type: signal.type,
        sequence: signal.frame.sequence,
        depth: signal.depth,
        reason: signal.reason,
      });
    } else {
      this.emit(signal);
    }
    this.emitSnapshot();
  }

  private setState(state: TransportState): void {
    if (this.transportState === state) return;
    this.transportState = state;
    this.emit({ type: "transport.state.changed", state });
    this.emitSnapshot();
  }

  private emit(event: TransportEvent): void {
    try {
      this.onEvent?.(event);
    } catch (error) {
      if (import.meta.env.DEV) console.debug("[Transport] event handler failed", error);
    }
  }

  private emitSnapshot(): void {
    this.onSnapshot?.(this.snapshot);
  }

  private resolvePendingConnect(): void {
    this.resolveConnect?.();
    this.resolveConnect = null;
    this.rejectConnect = null;
    this.connectPromise = null;
  }

  private rejectPendingConnect(error: Error): void {
    this.rejectConnect?.(error);
    this.resolveConnect = null;
    this.rejectConnect = null;
    this.connectPromise = null;
  }

  private failConnect(error: Error): void {
    this.emit({ type: "transport.error", reason: error.message, error });
    this.rejectPendingConnect(error);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      this.clearTimer(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearSetupTimer(): void {
    if (this.setupTimer !== null) {
      this.clearTimer(this.setupTimer);
      this.setupTimer = null;
    }
  }

  private clearSocketAndTimers(): void {
    this.clearHeartbeat();
    this.clearSetupTimer();
    this.socket = null;
    this.setupSent = false;
    this.setupComplete = false;
  }

  private debug(message: string, details?: unknown): void {
    if (DEBUG_TRANSPORT && import.meta.env.DEV) {
      console.debug(new Date().toISOString(), message, details ?? "");
    }
  }
}

function appendAccessToken(url: string, token: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}access_token=${encodeURIComponent(token)}`;
}

function redactToken(url: string): string {
  return url.replace(/([?&]access_token=)[^&]*/i, "$1<redacted>");
}

function parseIncoming(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    try {
      const value: unknown = JSON.parse(raw);
      return isRecord(value) ? value : null;
    } catch (error) {
      if (import.meta.env.DEV) console.debug("[Transport] incoming JSON parse failed", error);
      return null;
    }
  }
  return isRecord(raw) ? raw : null;
}

function isSetupComplete(message: Record<string, unknown>): boolean {
  return message.setupComplete === true || message.setup_complete === true;
}

function readResumptionHandle(message: Record<string, unknown>): string | null {
  const direct = message.sessionResumptionHandle;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const update = message.sessionResumptionUpdate ?? message.session_resumption_update;
  if (isRecord(update)) {
    const handle = update.newHandle ?? update.new_handle;
    if (typeof handle === "string" && handle.length > 0) return handle;
  }
  return null;
}

function findMessageType(message: Record<string, unknown>): string {
  if (isSetupComplete(message)) return "setupComplete";
  if (message.serverContent !== undefined || message.server_content !== undefined) return "serverContent";
  if (message.sessionResumptionUpdate !== undefined || message.session_resumption_update !== undefined) {
    return "sessionResumptionUpdate";
  }
  return "unknown";
}

function isValidAudioFrame(frame: AudioFrame): boolean {
  return (
    frame.sampleRate === 16_000 &&
    frame.channels === 1 &&
    frame.format === "pcm_s16le" &&
    frame.durationMs === 20 &&
    frame.data instanceof ArrayBuffer
  );
}

function isBinaryPayload(value: unknown): boolean {
  return value instanceof ArrayBuffer || value instanceof Uint8Array || ArrayBuffer.isView(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}
