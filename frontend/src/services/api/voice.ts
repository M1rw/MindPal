import { ApiError, fetchJson } from './http.ts';
import type { VoiceSummaryRequest, VoiceSummaryResponse } from '../../types/index.ts';
import type { VoiceTraceReport } from '../../voice/diagnostics/trace.ts';

export type VoiceErrorKind = 'quota' | 'auth' | 'conflict' | 'unavailable' | 'invalid' | 'unknown';

export function classifyVoiceError(error: unknown): { kind: VoiceErrorKind; message: string } {
  const apiError = error instanceof ApiError ? error : null;
  const code = apiError?.code || '';
  if (code === 'quota_exceeded' || apiError?.status === 429) {
    return { kind: 'quota', message: 'Your live voice time is used up for now. You can continue in text or try again later.' };
  }
  if (code === 'unauthenticated' || apiError?.status === 401) {
    return { kind: 'auth', message: 'Sign in to start a live voice call. Dictation still works without an account.' };
  }
  if (code === 'conflict' || apiError?.status === 409) {
    return { kind: 'conflict', message: 'Another live voice call is already active. Close it before starting a new one.' };
  }
  if (code === 'unavailable' || (apiError?.status ?? 0) >= 500) {
    return { kind: 'unavailable', message: 'Live voice is temporarily unavailable. You can use dictation instead.' };
  }
  if (code === 'payload_invalid' || (apiError?.status ?? 0) === 422) {
    return { kind: 'invalid', message: apiError?.message || 'Live voice could not start with these settings.' };
  }
  return {
    kind: 'unknown',
    message: error instanceof Error && error.message ? error.message : 'Live voice could not start. You can use dictation instead.',
  };
}

export interface VoiceUsageSnapshot {
  used_s: number;
  cap_s: number;
  remaining_s: number;
  reserve_s: number;
  in_call: boolean;
  day: string;
  session_mode?: 'guest' | 'account';
  quota_label?: 'guest' | 'account';
  max_session_seconds?: number;
  daily_cap_seconds?: number;
  quota_message?: string;
}

export const voiceApi = {
  /** Today's live-voice budget. Separate pool from chat credits. */
  async getVoiceUsage(): Promise<VoiceUsageSnapshot> {
    return fetchJson<VoiceUsageSnapshot>(
      '/api/voice/usage',
      { method: 'GET' },
      'Live voice usage is unavailable right now.',
    );
  },

  /** A memory or past-chat lookup the live model asked for, for the caller's own call. */
  async recall(
    sessionId: string,
    tool: 'search_memory' | 'search_past_chats',
    query: string,
  ): Promise<{ result: string; found: boolean }> {
    return fetchJson<{ result: string; found: boolean }>(
      '/api/voice/recall',
      {
        method: 'POST',
        body: JSON.stringify({ session_id: sessionId, tool, query }),
      },
      'Voice recall unavailable',
    );
  },

  /** The face's silent reaction to a phrase the caller just said, in any language. */
  async classifyReaction(
    text: string,
    context: string,
    speaker: 'caller' | 'mindpal' = 'caller',
  ): Promise<{ reaction: string }> {
    return fetchJson<{ reaction: string }>(
      '/api/voice/reaction',
      {
        method: 'POST',
        body: JSON.stringify({ text, context, speaker }),
      },
      'Voice reaction unavailable',
    );
  },

  async summarizeVoiceSession(payload: VoiceSummaryRequest): Promise<VoiceSummaryResponse> {
    return fetchJson<VoiceSummaryResponse>(
      '/api/voice/summarize',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      'Live voice recap failed',
    );
  },

  async submitDiagnostics(sessionId: string, trace: VoiceTraceReport): Promise<{ ok: boolean; request_id: string }> {
    return fetchJson<{ ok: boolean; request_id: string }>(
      '/api/voice/trace',
      {
        method: 'POST',
        body: JSON.stringify({ session_id: sessionId, trace }),
      },
      'Voice diagnostics unavailable',
    );
  },
};
