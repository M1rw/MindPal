import { computeRmsDb, RMS_SILENCE_DB } from "./signal_processing.js";

/**
 * Client-side Voice Activity Detector (VAD).
 *
 * Algorithm — two-threshold hysteresis with frame holdoffs:
 *   Onset:  N consecutive frames >= speechThresholdDb → declare speaking
 *   End:    M consecutive frames <  silenceThresholdDb → declare speech ended
 *
 * Hysteresis (speechThreshold > silenceThreshold) prevents rapid toggling
 * when the user's level hovers near the boundary mid-word.
 *
 * Defaults tuned for close-mic conversational speech at arm's length:
 *   speechThresholdDb  = -26 dBFS  (~normal talking level)
 *   silenceThresholdDb = -38 dBFS  (12 dB below onset to stop false endings)
 *   onsetFrames        = 2  × 20 ms = 40 ms  (instant onset feel)
 *   endFrames          = 20 × 20 ms = 400 ms (natural pause tolerance)
 */

// Exported so tests can reference the same defaults.
export const VAD_DEFAULTS = Object.freeze({
  speechThresholdDb: -26,
  silenceThresholdDb: -38,
  onsetFrames: 2,
  endFrames: 20,
});

export function createVad({
  speechThresholdDb = VAD_DEFAULTS.speechThresholdDb,
  silenceThresholdDb = VAD_DEFAULTS.silenceThresholdDb,
  onsetFrames = VAD_DEFAULTS.onsetFrames,
  endFrames = VAD_DEFAULTS.endFrames,
  onSpeechStart = () => {},
  onSpeechEnd = () => {},
  onLevel = () => {},
} = {}) {
  // Clamp to sane ranges
  const threshHigh = Math.min(0, Math.max(-80, speechThresholdDb));
  const threshLow  = Math.min(threshHigh - 1, Math.max(-96, silenceThresholdDb));
  const nOnset     = Math.max(1, Math.min(60, onsetFrames));
  const nEnd       = Math.max(1, Math.min(200, endFrames));

  let speaking = false;
  let consecutiveAbove = 0;
  let consecutiveBelow = 0;
  let lastRmsDb = RMS_SILENCE_DB;

  /**
   * Feed one audio frame (Float32Array of mono PCM in [-1,1]) to the VAD.
   * Returns { rmsDb, speaking }.
   */
  function update(samples) {
    const rmsDb = computeRmsDb(samples);
    lastRmsDb = rmsDb;

    if (!speaking) {
      if (rmsDb >= threshHigh) {
        consecutiveAbove++;
        consecutiveBelow = 0;
        if (consecutiveAbove >= nOnset) {
          speaking = true;
          consecutiveAbove = 0;
          try { onSpeechStart(); } catch {}
        }
      } else {
        consecutiveAbove = 0;
      }
    } else {
      if (rmsDb < threshLow) {
        consecutiveBelow++;
        if (consecutiveBelow >= nEnd) {
          speaking = false;
          consecutiveBelow = 0;
          try { onSpeechEnd(); } catch {}
        }
      } else {
        consecutiveBelow = 0;
      }
    }

    const result = Object.freeze({ rmsDb, speaking });
    try { onLevel(result); } catch {}
    return result;
  }

  function reset() {
    speaking = false;
    consecutiveAbove = 0;
    consecutiveBelow = 0;
    lastRmsDb = RMS_SILENCE_DB;
  }

  return Object.freeze({
    update,
    reset,
    isSpeaking: () => speaking,
    getLevel: () => Object.freeze({ rmsDb: lastRmsDb, speaking }),
  });
}
