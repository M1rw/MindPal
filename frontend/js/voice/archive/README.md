# MindPal Voice V2 Archive

Voice V2 is no longer selected by the production facade. Its session implementation is preserved in `voice_session_v2.legacy.js`, and its lower-level runtime and layer modules remain available for rollback, regression tests, and forensic comparison. The active production entrypoint is `frontend/js/voice_session.js`, which loads the Voice V3 runtime bundle from `/voice-v3/assets/runtime.js`.

This archive is intentionally reversible: no V2 source or test fixture is deleted, and production V2 is not served by the active facade.
