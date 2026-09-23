import { useSettingsStore, useUsageStore } from '../../store/index.ts';
import type { MemoryReceipt, MemoryReceiptItem, UserPersonalization, UsageQuota } from '../../types/index.ts';
import { fetchWithAuth, parseErrorMessage } from './http.ts';

export const MAX_CHAT_HISTORY_TURNS = 30;

async function getClientContext(): Promise<Record<string, unknown>> {
  const context: Record<string, unknown> = {};
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timezone) context.timezone = timezone;
    if (typeof navigator !== 'undefined' && navigator.language) context.locale = navigator.language;
  } catch {
    // Browser context is optional.
  }

  let locationPermission = 'denied';
  if (typeof navigator !== 'undefined' && navigator.permissions) {
    try {
      locationPermission = (await navigator.permissions.query({ name: 'geolocation' })).state;
    } catch {
      locationPermission = 'denied';
    }
  }

  if (locationPermission === 'granted' && typeof navigator !== 'undefined' && navigator.geolocation) {
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: false,
          maximumAge: 300_000,
          timeout: 4_000,
        });
      });
      context.location = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy_m: position.coords.accuracy,
      };
    } catch {
      // Location is permission-gated and optional; timezone still works.
    }
  }
  return context;
}

/**
 * Server credit windows -> the usage store. Missing or non-numeric fields make
 * the snapshot unusable rather than being filled with guessed limits, so the
 * Usage screen never shows a number the server did not send.
 */
export function parseUsage(raw: unknown): UsageQuota | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  const num = (key: string): number | null => {
    const value = Number(body[key]);
    return Number.isFinite(value) ? value : null;
  };
  const credits5h = num('credits_5h');
  const limit5h = num('limit_5h');
  if (credits5h === null || limit5h === null) return null;
  const reset5h = Math.max(0, num('reset_5h_seconds') ?? 0);
  return {
    used: credits5h,
    limit: limit5h,
    resets_at: new Date(Date.now() + reset5h * 1000).toISOString(),
    credits_5h: credits5h,
    limit_5h: limit5h,
    reset_5h_seconds: reset5h,
    credits_week: num('credits_week') ?? undefined,
    limit_week: num('limit_week') ?? undefined,
    reset_week_seconds: num('reset_week_seconds') ?? undefined,
    scope: body.scope === 'network' ? 'network' : 'account',
  };
}

export function syncUsage(raw: unknown): void {
  const quota = parseUsage(raw);
  if (quota) useUsageStore.getState().setQuota(quota);
}

export function parseMemoryReceipt(raw: unknown): MemoryReceipt | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  if (!Array.isArray(body.saved)) return null;
  const saved: MemoryReceiptItem[] = [];
  for (const item of body.saved) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const text = typeof record.text === 'string' ? record.text.trim() : '';
    if (!id || !text) continue;
    const type = typeof record.type === 'string' && record.type.trim() ? record.type.trim() : 'facts';
    saved.push({ id, type, text });
  }
  if (saved.length === 0) return null;
  const count = typeof body.count === 'number' && Number.isFinite(body.count) ? body.count : saved.length;
  return { saved, count: Math.max(count, saved.length) };
}

export const chatApi = {
  async streamChat(
    message: string,
    history: Array<{ role: string; content: string }>,
    onChunk: (chunk: string, strategy?: string) => void,
    onComplete: () => void,
    onError: (err: Error) => void,
    options?: {
      model?: string;
      telemetry?: unknown;
      personalization?: UserPersonalization;
      signal?: AbortSignal;
      onMemory?: (receipt: MemoryReceipt) => void;
    },
  ): Promise<void> {
    try {
      const activePersonalization = options?.personalization ?? useSettingsStore.getState().settings.personalization;
      const clientContext = await getClientContext();
      const response = await fetchWithAuth('/api/chat/stream', {
        method: 'POST',
        signal: options?.signal,
        body: JSON.stringify({
          message,
          history: history.slice(-MAX_CHAT_HISTORY_TURNS).map((turn) => ({
            role: turn.role,
            content: turn.content,
          })),
          stream: true,
          model: options?.model || 'standard',
          telemetry: options?.telemetry,
          personalization: activePersonalization,
          client_context: clientContext,
        }),
      });

      if (!response.ok) {
        const detail = await parseErrorMessage(response, 'Chat failed');
        throw new Error(detail);
      }

      if (!response.body) throw new Error('Response body is null');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        if (options?.signal?.aborted) {
          try {
            await reader.cancel();
          } catch {
            // ignore
          }
          onComplete();
          return;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const rawData = line.slice(5).replace(/^ /, '');
          if (rawData === '[DONE]') {
            onComplete();
            return;
          }
          try {
            const data = JSON.parse(rawData) as Record<string, unknown> | string;
            if (typeof data === 'object' && data !== null) {
              if (data.usage && typeof data.usage === 'object') {
                syncUsage(data.usage);
              }
              if (data.memory) {
                const receipt = parseMemoryReceipt(data.memory);
                if (receipt) options?.onMemory?.(receipt);
              }
              if (data.error && typeof data.error === 'object') {
                const errBody = data.error as { message?: unknown };
                const message = typeof errBody.message === 'string' && errBody.message.trim()
                  ? errBody.message
                  : 'Chat failed';
                throw new Error(message);
              }
              const record = data as Record<string, unknown>;
              const textChunk = String(record.text ?? record.content ?? record.token ?? '');
              const strategy = typeof record.strategy_used === 'string' ? record.strategy_used : undefined;
              if (textChunk) onChunk(textChunk, strategy);
            } else if (typeof data === 'string') {
              onChunk(data);
            }
          } catch (err) {
            if (err instanceof SyntaxError) {
              if (rawData) onChunk(rawData);
              continue;
            }
            throw err;
          }
        }
      }

      onComplete();
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.message?.toLowerCase().includes('abort'))) {
        onComplete();
        return;
      }
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  },

};
