import { useSessionStore } from '../../store/index.ts';
import { getApiBaseUrl } from '../config.ts';

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

/** Compose a caller-supplied signal with our timeout without dropping either. */
function withTimeout(options: TimedRequestInit): { signal: AbortSignal; done: () => void } {
  const ms = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!(ms > 0)) {
    return { signal: options.signal ?? new AbortController().signal, done: () => {} };
  }
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(new TimeoutError()), ms);
  const caller = options.signal;
  const onCallerAbort = () => controller.abort(caller?.reason);
  if (caller) {
    if (caller.aborted) controller.abort(caller.reason);
    else caller.addEventListener('abort', onCallerAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done: () => {
      globalThis.clearTimeout(timer);
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

export async function fetchWithAuth(path: string, options: TimedRequestInit = {}): Promise<Response> {
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
  const { signal, done } = withTimeout(options);
  const { timeoutMs: _timeoutMs, ...rest } = options;
  void _timeoutMs;
  try {
    const response = await fetch(url, { ...rest, headers, signal });
    if (response.status !== 401 || !idToken) return response;
    // One retry with a fresh token. A second 401 is a real authorisation
    // failure, not an expiry, so it is returned as-is.
    const fresh = await refreshIdToken();
    if (!fresh || fresh === idToken) return response;
    headers.set('Authorization', `Bearer ${fresh}`);
    return await fetch(url, { ...rest, headers, signal });
  } catch (error) {
    if (signal.aborted && signal.reason instanceof TimeoutError) throw signal.reason;
    throw error;
  } finally {
    done();
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
  const response = await fetchWithAuth(path, options);
  if (!response.ok) {
    throw await errorFromResponse(response, fallbackMessage);
  }
  return response.json() as Promise<T>;
}

export async function fetchBlob(path: string, options: TimedRequestInit = {}, fallbackMessage: string): Promise<Blob> {
  const response = await fetchWithAuth(path, options);
  if (!response.ok) {
    throw await errorFromResponse(response, fallbackMessage);
  }
  return response.blob();
}

export async function expectOk(path: string, options: TimedRequestInit = {}, fallbackMessage: string): Promise<void> {
  const response = await fetchWithAuth(path, options);
  if (!response.ok) {
    throw await errorFromResponse(response, fallbackMessage);
  }
}
