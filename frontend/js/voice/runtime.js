// Legacy Voice runtime compatibility shim.
// The production facade defaults to voice_session_v2.js. The complete previous
// implementation, including the remote caption-synchronization fixes, is
// preserved at ./archive/runtime.legacy.js for rollback and forensic comparison.
export { createVoiceSessionController } from "./archive/runtime.legacy.js";
