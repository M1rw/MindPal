// Legacy Voice runtime compatibility shim.
// The production facade defaults to voice_session_v2.js. The complete previous
// implementation is preserved at ./archive/runtime.legacy.js for rollback,
// forensic comparison, and targeted regression tests.
export { createVoiceSessionController } from "./archive/runtime.legacy.js";
