import type { LiveFunctionCall } from './face/expressionCommand.ts';

export type FloorState =
  | 'idle'
  | 'listening'
  | 'speaking'
  | 'overlapping'
  | 'holding'
  | 'yielding'
  | 'crisis_freeze';

export type LiveUiStatus =
  | 'consent'
  | 'connecting'
  | 'listening'
  | 'speaking'
  | 'holding'
  | 'unavailable'
  | 'error'
  | 'stay_support'
  | 'crisis_freeze';

export interface VoiceLiveGrant {
  token: string;
  expires_at: string;
  ws_url: string;
  model: string;
  voice_id: string;
  session_id: string;
  quota_remaining_s: number;
  setup_timeout_ms: number;
  hold_ms: number;
  /** How often the client must re-report transcripts to stay verified server-side. */
  safety_heartbeat_ms?: number;
  /** Whether the provider accepted `safetySettings` on this mint. */
  safety_settings_applied?: boolean;
  /** Whether Constrained v1alpha accepted `proactivity`. False after a named 400. */
  proactivity_applied?: boolean;
  session_limit_s?: number;
  /** Seconds from mint after which the client should rotate. Omitted or 0 = hold one socket. */
  provider_rotate_s?: number;
  new_session_expires_at?: string;
  session_resumption_applied?: boolean;
  /** Server session graph for mid-call reconnect seed. */
  working_memory?: Record<string, unknown>;
  call_elapsed_s?: number;
  /**
   * Which provider and model serves each path for this call. Resolved from
   * server env the browser cannot see, and carried here so a diagnostic report
   * says which classifier actually produced a verdict.
   */
  models?: {
    live?: string;
    live_voice?: string;
    chat_provider?: string;
    chat_model?: string;
    classifier_provider?: string;
    classifier_model?: string;
    classifier_mode?: string;
  };
  setup: { setup: Record<string, unknown> };
}

export interface ControlPlaneAction {
  ok: boolean;
  /**
   * `safety_unverified` is what the client synthesises when the control plane
   * cannot be reached. It is never `continue`: a failed safety report means the
   * transcript was not classified, which is not the same as being safe.
   * `stay_support` keeps the live call up. `escalate_pause` with `speak_first`
   * keeps the socket so MindPal can answer the situation out loud, then pauses.
   * `escalate_pause` (and legacy `crisis_freeze`) with `terminal: true` pauses it.
   * Classifier errors must not become a pause.
   */
  action: 'continue' | 'stay_support' | 'escalate_pause' | 'crisis_freeze' | 'torn_down' | 'safety_unverified';
  floor?: string;
  crisis_response?: string;
  session_note?: string;
  situation_nudge?: string;
  pause_body?: string;
  danger_kind?: string;
  /** stay_support for danger happening now. The call continues; MindPal names immediate help. */
  imminent?: boolean;
  speak_first?: boolean;
  label?: string;
  refund_s?: number;
  /** Server-side confirmation that a transcript was classified recently. */
  safety_verified?: boolean;
  /** Set on escalate-pause: the session will refuse every further event but teardown. */
  terminal?: boolean;
  /** In-call working memory echoed from the server on renew/sync. */
  working_memory?: Record<string, unknown>;
  gemini_classify_calls?: number;
  gemini_classify_skips?: number;
}

export interface GeminiLiveHandlers {
  onSetupComplete: () => void;
  onAudio: (pcm: Int16Array) => void;
  onInterrupted: () => void;
  onInputTranscript: (text: string, isFinal: boolean) => void;
  onOutputTranscript: (text: string) => void;
  onGenerationComplete?: () => void;
  /** Provider closed the turn. Often the only completion an interrupted turn gets. */
  onTurnComplete?: () => void;
  onToolCalls?: (calls: LiveFunctionCall[]) => void;
  onGoAway?: () => void;
  onSessionResumption?: (handle: string) => void;
  onError: (message: string) => void;
  onClose: (code: number, reason: string) => void;
}

export interface ParsedLiveMessage {
  setupComplete: boolean;
  interrupted: boolean;
  audioChunks: Int16Array[];
  inputTranscript: string;
  outputTranscript: string;
  turnComplete: boolean;
  inputFinished: boolean;
  generationComplete: boolean;
  goAway: boolean;
  sessionResumptionHandle: string;
  toolCalls: LiveFunctionCall[];
  error: string | null;
}
