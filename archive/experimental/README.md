# Experimental frontend code

These files are intentionally excluded from the production frontend and Vercel deployment.

- `voice_emotion.js` uses fixed pitch, energy, pace, and silence heuristics. It is not sufficiently reliable for mental-health, safety, or clinical decisions and must not be re-enabled without calibration data, consent UX, bias testing, and backend policy review.
- `voice-assets/` contains unused voice reference recordings retained from the original repository.
