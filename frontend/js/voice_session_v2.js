// Archived Voice V2 compatibility export.
// The active production facade is Voice V3 in voice_session.js.
export {
  createVoiceSessionV2,
  buildDeliveryDiagnosticPayload,
  buildAutomaticGreetingText,
  isDuplicateTranscriptSnapshot,
} from "./voice/archive/voice_session_v2.legacy.js";
