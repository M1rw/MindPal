import { useSessionStore } from '../../store/index.ts';
import { getApiBaseUrl } from '../config.ts';

/**
 * A key for one logical operation (one chat send, one voice event). Retries of
 * that same operation reuse it so the server charges and applies it once; a
 * new operation always gets a new key (audit MP-26).
 */
export function newOperationKey(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function isUnauthenticatedError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.code === 'unauthenticated');
}

/**
 * Default request ceiling. `fetch` has no timeout of its own: without this a
 * stalled connection stays pending for minutes. On the live-voice control plane
 * that is not just a slow request — upstream microphone PCM is gated while a
 * classify call is in flight, so a hung request silently deafens the call.
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

export class TimeoutError extends Error {
  constructor(message = 'The request timed out.') {
    super(message);
    this.name = 'TimeoutError';
  }
}

export interface TimedRequestInit extends RequestInit {
  /** Override the default ceiling. 0 or a negative value disables it. */
  timeoutMs?: number;
}

interface RequestLifetime {
  signal: AbortSignal;
  /** Headers arrived: stop the header deadline (the body may still be streaming). */
  stopTimer: () => void;
  /** The request is completely finished: detach from the caller's signal too. */
  release: () => void;
}

/**
 * Compose a caller-supplied signal with our timeout without dropping either.
 *
 * Audit MP-13: this used to be torn down as soon as fetch() resolved, i.e. when
 * headers arrived. A response that then stalled mid-body could not be stopped:
 * pressing Stop aborted the caller's signal, but the signal fetch was actually
 * using no longer listened to it, and the timeout had been cleared. The
 * caller's abort now stays wired to the request until the body is done.
 */
function withTimeout(options: TimedRequestInit): RequestLifetime {
  const ms = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = ms > 0 ? globalThis.setTimeout(() => controller.abort(new TimeoutError()), ms) : null;
  const caller = options.signal;
  const onCallerAbort = () => controller.abort(caller?.reason);
  if (caller) {
    if (caller.aborted) controller.abort(caller.reason);
    else caller.addEventListener('abort', onCallerAbort, { once: true });
  }
  const stopTimer = () => {
    if (timer !== null) globalThis.clearTimeout(timer);
  };
  return {
    signal: controller.signal,
    stopTimer,
    release: () => {
      stopTimer();
      caller?.removeEventListener('abort', onCallerAbort);
    },
  };
}

/**
 * Force-refresh the cached ID token after a 401.
 *
 * Belt to the braces of the onIdTokenChange subscription: a token can still
 * expire between building a request and the server validating it, and on the
 * live-voice control plane a dropped event is a floor transition or a safety
 * classify that silently never happened.
 *
 * Imported lazily so this module does not pull the auth service into every
 * consumer, and deduped so a burst of 401s triggers one refresh, not twenty.
 */
let refreshInFlight: Promise<string | null> | null = null;

async function refreshIdToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const { getIdToken } = await import('../auth/index');
      const token = await getIdToken({ forceRefresh: true });
      if (token) {
        const { userId, appCheckToken } = useSessionStore.getState();
        useSessionStore.getState().setAuth(userId ?? null, token, appCheckToken ?? null);
      }
      return token;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/**
 * Authenticated fetch. `timeoutMs` bounds the wait for response headers; the
 * caller's `signal` keeps working for the whole response, body included, so a
 * streaming reader can still be stopped after the headers arrived.
 */
export async function fetchWithAuth(path: string, options: TimedRequestInit = {}): Promise<Response> {
  const { response } = await openRequest(path, options);
  return response;
}

/**
 * Like fetchWithAuth, but the deadline covers reading the body as well: `read`
 * runs before the timer is cleared. For JSON, blobs and plain status checks.
 */
async function fetchAndRead<T>(path: string, options: TimedRequestInit, read: (response: Response) => Promise<T>): Promise<T> {
  const { response, lifetime } = await openRequest(path, options, { keepTimer: true });
  let onAbort: (() => void) | null = null;
  // Stop reading the moment the deadline or the caller aborts, whether or not
  // the body stream notices the abort itself.
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(lifetime.signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (lifetime.signal.aborted) onAbort();
    else lifetime.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([read(response), aborted]);
  } catch (error) {
    if (lifetime.signal.aborted && lifetime.signal.reason instanceof TimeoutError) throw lifetime.signal.reason;
    throw error;
  } finally {
    if (onAbort) lifetime.signal.removeEventListener('abort', onAbort);
    lifetime.release();
    // An abandoned body must not keep the connection open.
    if (!response.bodyUsed) response.body?.cancel().catch(() => {});
  }
}

async function openRequest(
  path: string,
  options: TimedRequestInit,
  { keepTimer = false }: { keepTimer?: boolean } = {},
): Promise<{ response: Response; lifetime: RequestLifetime }> {
  const { idToken, appCheckToken } = useSessionStore.getState();
  const headers = new Headers(options.headers ?? {});

  if (options.body !== undefined && options.body !== null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (idToken) {
    headers.set('Authorization', `Bearer ${idToken}`);
  }

  if (appCheckToken) {
    headers.set('X-Firebase-AppCheck', appCheckToken);
  }

  const baseUrl = getApiBaseUrl();
  const cleanPath = baseUrl.endsWith('/api') && path.startsWith('/api')
    ? path.slice(4)
    : path;

  const url = `${baseUrl}${cleanPath}`;
  const lifetime = withTimeout(options);
  const { signal } = lifetime;
  const { timeoutMs: _timeoutMs, ...rest } = options;
  void _timeoutMs;
  try {
    let response = await fetch(url, { ...rest, headers, signal });
    if (response.status === 401 && idToken) {
      // One retry with a fresh token. A second 401 is a real authorisation
      // failure, not an expiry, so it is returned as-is.
      const fresh = await refreshIdToken();
      if (fresh && fresh !== idToken) {
        headers.set('Authorization', `Bearer ${fresh}`);
        response = await fetch(url, { ...rest, headers, signal });
      }
    }
    if (!keepTimer) lifetime.stopTimer();
    return { response, lifetime };
  } catch (error) {
    lifetime.release();
    if (signal.aborted && signal.reason instanceof TimeoutError) throw signal.reason;
    throw error;
  }
}

export async function parseErrorMessage(response: Response, fallbackMessage: string): Promise<string> {
  const error = await errorFromResponse(response, fallbackMessage);
  return error.message;
}

async function errorFromResponse(response: Response, fallbackMessage: string): Promise<ApiError> {
  let code: string | null = null;
  try {
    const bodyText = await response.text();
    if (!bodyText) {
      return new ApiError(response.statusText || fallbackMessage, response.status);
    }

    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown> | string;
      if (typeof parsed === 'string' && parsed.trim()) {
        return new ApiError(parsed, response.status);
      }
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.code === 'string' && parsed.code.trim()) {
          code = parsed.code;
        }
        const detail = parsed.detail ?? parsed.error ?? parsed.message;
        if (typeof detail === 'string' && detail.trim()) {
          return new ApiError(detail, response.status, code);
        }
      }
      return new ApiError(bodyText, response.status, code);
    } catch {
      return new ApiError(bodyText, response.status, code);
    }
  } catch {
    return new ApiError(fallbackMessage, response.status, code);
  }
}

export async function fetchJson<T>(path: string, options: TimedRequestInit = {}, fallbackMessage: string): Promise<T> {
  return fetchAndRead(path, options, async (response) => {
    if (!response.ok) throw await errorFromResponse(response, fallbackMessage);
    return (await response.json()) as T;
  });
}

export async function fetchBlob(path: string, options: TimedRequestInit = {}, fallbackMessage: string): Promise<Blob> {
  return fetchAndRead(path, options, async (response) => {
    if (!response.ok) throw await errorFromResponse(response, fallbackMessage);
    return response.blob();
  });
}

export async function expectOk(path: string, options: TimedRequestInit = {}, fallbackMessage: string): Promise<void> {
  return fetchAndRead(path, options, async (response) => {
    if (!response.ok) throw await errorFromResponse(response, fallbackMessage);
  });
}
