export type VoiceToken = {
  readonly token: string;
  readonly model: string;
  readonly websocketUrl: string;
  readonly expiresAt: number;
  readonly newSessionExpiresAt: number;
};

export interface TokenProvider {
  getToken(): Promise<VoiceToken>;
}

export type MockTokenProviderOptions = {
  readonly token?: string;
  readonly model?: string;
  readonly websocketUrl?: string;
  readonly ttlMs?: number;
  readonly newSessionTtlMs?: number;
  readonly nowMono?: () => number;
};

/**
 * Temporary provider used by the isolated Voice V3 debug app and tests.
 * Production integration will replace this with the authenticated backend
 * ephemeral-token endpoint without changing the WebSocket manager contract.
 */
export class MockTokenProvider implements TokenProvider {
  private readonly token: string;
  private readonly model: string;
  private readonly websocketUrl: string;
  private readonly ttlMs: number;
  private readonly newSessionTtlMs: number;
  private readonly nowMono: () => number;

  public constructor(options: MockTokenProviderOptions = {}) {
    this.token = options.token ?? "mock.jwt.voice-v3";
    this.model = options.model ?? "gemini-3.1-flash-live-preview";
    this.websocketUrl =
      options.websocketUrl ?? "wss://generativelanguage.googleapis.com/ws/mock";
    this.ttlMs = options.ttlMs ?? 30 * 60 * 1_000;
    this.newSessionTtlMs = options.newSessionTtlMs ?? 60 * 1_000;
    this.nowMono = options.nowMono ?? (() => Date.now());
  }

  public async getToken(): Promise<VoiceToken> {
    const now = this.nowMono();
    return {
      token: this.token,
      model: this.model,
      websocketUrl: this.websocketUrl,
      expiresAt: now + this.ttlMs,
      newSessionExpiresAt: now + this.newSessionTtlMs,
    };
  }
}
