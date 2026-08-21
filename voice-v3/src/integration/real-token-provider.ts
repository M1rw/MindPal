import type { TokenProvider, VoiceToken } from "../layers/transport/token-provider";

export type RealTokenProviderOptions = {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly getAuthToken?: () => Promise<string | null>;
  readonly getAppCheckToken?: () => Promise<string | null>;
  readonly refreshAuthToken?: () => Promise<string | null>;
  readonly refreshAppCheckToken?: () => Promise<string | null>;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly nowMs?: () => number;
  readonly fallbackGrant?: () => string | null;
};

export type RealVoiceToken = VoiceToken & {
  readonly fallbackGrant: string | null;
  readonly fallbackUsed: boolean;
};

export class VoiceTokenError extends Error {
  public readonly status: number | null;
  public readonly retryable: boolean;
  public readonly retryAfterMs: number;

  public constructor(message: string, options: {
    readonly status?: number | null;
    readonly retryable?: boolean;
    readonly retryAfterMs?: number;
  } = {}) {
    super(message);
    this.name = "VoiceTokenError";
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? true;
    this.retryAfterMs = options.retryAfterMs ?? 0;
  }
}

/** Authenticated, short-lived production token provider. It never sends audio or transcripts. */
export class RealTokenProvider implements TokenProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getAuthToken: () => Promise<string | null>;
  private readonly getAppCheckToken: () => Promise<string | null>;
  private readonly refreshAuthToken: (() => Promise<string | null>) | undefined;
  private readonly refreshAppCheckToken: (() => Promise<string | null>) | undefined;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly nowMs: () => number;
  private readonly fallbackGrant: (() => string | null) | undefined;
  private cached: RealVoiceToken | null = null;

  public constructor(options: RealTokenProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.getAuthToken = options.getAuthToken ?? (async () => null);
    this.getAppCheckToken = options.getAppCheckToken ?? (async () => null);
    this.refreshAuthToken = options.refreshAuthToken;
    this.refreshAppCheckToken = options.refreshAppCheckToken;
    this.maxAttempts = Math.max(1, Math.min(4, options.maxAttempts ?? 2));
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 250);
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.fallbackGrant = options.fallbackGrant;
  }

  public get lastToken(): RealVoiceToken | null {
    return this.cached;
  }

  public async getToken(): Promise<RealVoiceToken> {
    if (this.cached && this.cached.expiresAt - this.nowMs() > 30_000) return this.cached;

    let authToken = await this.getAuthToken();
    let appCheckToken = await this.getAppCheckToken();
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(this.buildUrl(), {
          method: "GET",
          headers: buildHeaders(authToken, appCheckToken),
          cache: "no-store",
          // The Vercel preview uses same-origin SSO cookies. Keep cookies for
          // same-origin token calls, but do not send them cross-origin.
          credentials: "same-origin",
        });
        if (!response.ok) {
          const error = await responseToError(response, this.nowMs());
          if (error.status === 401 || error.status === 403) {
            if (this.refreshAuthToken) authToken = await this.refreshAuthToken();
            if (this.refreshAppCheckToken) appCheckToken = await this.refreshAppCheckToken();
          }
          if (attempt < this.maxAttempts && error.retryable && error.status !== 429) {
            await sleep(Math.max(this.retryDelayMs, error.retryAfterMs));
            continue;
          }
          throw error;
        }

        const parsed = await response.json() as unknown;
        const token = parseVoiceToken(parsed, this.nowMs());
        this.cached = token;
        return token;
      } catch (error) {
        lastError = error;
        const normalized = error instanceof VoiceTokenError
          ? error
          : new VoiceTokenError(error instanceof Error ? error.message : "Voice token network request failed");
        if (attempt >= this.maxAttempts || !normalized.retryable || normalized.status === 429) throw normalized;
        await sleep(Math.max(this.retryDelayMs, normalized.retryAfterMs));
      }
    }
    throw lastError instanceof Error ? lastError : new VoiceTokenError("Voice token request failed");
  }

  private buildUrl(): string {
    const grant = this.fallbackGrant?.();
    const url = `${this.baseUrl}/api/voice/token`;
    return grant ? `${url}?fallback_grant=${encodeURIComponent(grant)}` : url;
  }
}

function buildHeaders(authToken: string | null, appCheckToken: string | null): HeadersInit {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  if (appCheckToken) headers["X-Firebase-AppCheck"] = appCheckToken;
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timezone) headers["X-MindPal-Timezone"] = timezone;
  } catch {
    // Timezone is diagnostic context only.
  }
  return headers;
}

async function responseToError(response: Response, nowMs: number): Promise<VoiceTokenError> {
  const retryAfterMs = parseRetryAfter(response.headers, nowMs);
  let message = `Voice token request failed with HTTP ${response.status}`;
  try {
    const body = await response.json() as { readonly detail?: { readonly message?: string } | string; readonly message?: string };
    const detail = typeof body.detail === "string" ? body.detail : body.detail?.message;
    message = detail || body.message || message;
  } catch {
    // The status code remains the safe error detail.
  }
  return new VoiceTokenError(message, {
    status: response.status,
    retryable: response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500,
    retryAfterMs,
  });
}

function parseVoiceToken(value: unknown, nowMs: number): RealVoiceToken {
  if (!isRecord(value)) throw new VoiceTokenError("Voice token response was not an object", { status: 502, retryable: false });
  const token = stringValue(value.token);
  const model = stringValue(value.model);
  const websocketUrl = stringValue(value.websocket_url ?? value.websocketUrl);
  const expiresAt = parseExpiry(value.expires_at ?? value.expiresAt);
  const newSessionExpiresAt = parseExpiry(value.new_session_expires_at ?? value.newSessionExpiresAt);
  if (!token || !model || !websocketUrl || expiresAt <= nowMs) {
    throw new VoiceTokenError("Voice token response was incomplete or expired", { status: 502, retryable: false });
  }
  return {
    token,
    model,
    websocketUrl,
    expiresAt,
    newSessionExpiresAt: newSessionExpiresAt > 0 ? newSessionExpiresAt : expiresAt,
    fallbackGrant: typeof value.fallback_grant === "string" ? value.fallback_grant : null,
    fallbackUsed: value.fallback_used === true,
  };
}

function parseExpiry(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1_000;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function parseRetryAfter(headers: Headers, nowMs: number): number {
  const value = headers.get("Retry-After") ?? headers.get("retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function sleep(delayMs: number): Promise<void> {
  return delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve();
}
