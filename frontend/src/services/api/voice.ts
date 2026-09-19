import { fetchJson } from './http.ts';
import { useSettingsStore } from '../../store/settings.ts';
import type { UserPersonalization, VoiceSummaryRequest, VoiceSummaryResponse, VoiceTokenResponse } from '../../types/index.ts';
import type { ControlPlaneAction } from '../../voice/types.ts';

export interface VoiceUsageSnapshot {
  used_s: number;
  cap_s: number;
  remaining_s: number;
  reserve_s: number;
  in_call: boolean;
  day: string;
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

  async mintVoiceSession(opts?: {
    voiceId?: string;
    voiceLanguage?: string;
    personalization?: UserPersonalization;
  }): Promise<VoiceTokenResponse> {
    const settings = useSettingsStore.getState().settings;
    const voice_id = opts?.voiceId ?? settings.voiceModel;
    const voice_language = opts?.voiceLanguage ?? settings.voiceLanguage;
    const personalization = opts?.personalization ?? settings.personalization;

    return fetchJson<VoiceTokenResponse>(
      '/api/voice/session-token',
      {
        method: 'POST',
        body: JSON.stringify({
          consent_attested: true,
          voice_id,
          voice_language,
          personalization,
        }),
      },
      'Live voice is not available right now.',
    );
  },

  async recordVoiceSessionEvent(payload: Record<string, unknown>): Promise<ControlPlaneAction> {
    return fetchJson<ControlPlaneAction>(
      '/api/voice/session-events',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      'Voice session event failed',
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
};
