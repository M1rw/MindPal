import { useSessionStore } from '../../store/index.ts';
import { getApiBaseUrl } from '../config.ts';

export async function fetchWithAuth(path: string, options: RequestInit = {}): Promise<Response> {
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
  return fetch(url, { ...options, headers });
}

export async function parseErrorMessage(response: Response, fallbackMessage: string): Promise<string> {
  try {
    const bodyText = await response.text();
    if (!bodyText) {
      return response.statusText || fallbackMessage;
    }

    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown> | string;
      if (typeof parsed === 'string' && parsed.trim()) {
        return parsed;
      }
      if (parsed && typeof parsed === 'object') {
        const detail = parsed.detail ?? parsed.error ?? parsed.message;
        if (typeof detail === 'string' && detail.trim()) {
          return detail;
        }
      }
      return bodyText;
    } catch {
      return bodyText;
    }
  } catch {
    return fallbackMessage;
  }
}

export async function fetchJson<T>(path: string, options: RequestInit = {}, fallbackMessage: string): Promise<T> {
  const response = await fetchWithAuth(path, options);
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, fallbackMessage));
  }
  return response.json() as Promise<T>;
}

export async function fetchBlob(path: string, options: RequestInit = {}, fallbackMessage: string): Promise<Blob> {
  const response = await fetchWithAuth(path, options);
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, fallbackMessage));
  }
  return response.blob();
}

export async function expectOk(path: string, options: RequestInit = {}, fallbackMessage: string): Promise<void> {
  const response = await fetchWithAuth(path, options);
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, fallbackMessage));
  }
}
