import { fetchJson } from './http.ts';

export interface DictationTranscript {
  text: string;
  /** The detected language ("english", "arabic", ...), or "" when unknown. */
  language: string;
}

export const dictationApi = {
  /** Send a recorded voice note; the server picks up whatever languages were spoken. */
  async transcribe(audio: Blob, languages: string[] = []): Promise<DictationTranscript> {
    return fetchJson<DictationTranscript>(
      '/api/transcribe',
      {
        method: 'POST',
        body: audio,
        headers: {
          'Content-Type': audio.type || 'audio/webm',
          ...(languages.length ? { 'X-Dictation-Languages': languages.join(',') } : {}),
        },
        timeoutMs: 45_000,
      },
      'Dictation error',
    );
  },
};
