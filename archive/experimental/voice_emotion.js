// frontend/js/voice_emotion.js — Real-time Voice Emotion Intelligence
//
// Analyses raw PCM audio frames + transcript timing to detect:
//   • Energy level (whispering → shouting)
//   • Pitch & pitch variance (monotone → erratic)
//   • Volume stability (stable → erratic = voice breaking)
//   • Speaking rate from transcript words (very slow → very fast)
//   • Silence / pause patterns (hesitant, withdrawn, pressured)
//
// Outputs a natural-language context string for Gemini injection.

// ═══════════════════════════════════════════════════════════════
// Thresholds (tuned for 16 kHz mono PCM, 4096-sample frames)
// ═══════════════════════════════════════════════════════════════

const SPEECH_RMS_THRESHOLD = 0.01;
const RMS_WINDOW_SIZE      = 30;   // ~30 frames ≈ 7.5 s
const PITCH_WINDOW_SIZE    = 20;   // ~20 voiced frames
const PITCH_FRAME_SKIP     = 3;    // analyse every 3rd frame (save CPU)
const WORD_HISTORY_MS      = 20_000;
const SILENCE_MIN_GAP_MS   = 500;
const SILENCE_HISTORY_LEN  = 10;
const INJECT_COOLDOWN_MS   = 18_000; // min 18 s between injections
const INJECT_MIN_FRAMES    = 25;     // need ~6 s of audio before first inject

// ═══════════════════════════════════════════════════════════════
// VoiceEmotionAnalyzer
// ═══════════════════════════════════════════════════════════════

export class VoiceEmotionAnalyzer {
  constructor(sampleRate = 16_000) {
    this.sampleRate = sampleRate;
    this._reset();
  }

  // ── Public API ──────────────────────────────────────────────

  /** Feed a Float32Array PCM frame (from AudioWorklet). */
  feedAudioFrame(buffer) {
    this._frameCount++;

    // ── RMS energy ──
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
    const rms = Math.sqrt(sum / buffer.length);

    this._rmsHistory.push(rms);
    if (this._rmsHistory.length > RMS_WINDOW_SIZE) this._rmsHistory.shift();

    // ── Speech / silence tracking ──
    const speaking = rms > SPEECH_RMS_THRESHOLD;
    const now = Date.now();

    if (speaking && !this._isSpeaking) {
      // Speech onset — record preceding silence gap
      if (this._lastSpeechEndTime > 0) {
        const gap = now - this._lastSpeechEndTime;
        if (gap > SILENCE_MIN_GAP_MS) {
          this._silenceGaps.push(gap);
          if (this._silenceGaps.length > SILENCE_HISTORY_LEN) this._silenceGaps.shift();
        }
      }
      this._isSpeaking = true;
    } else if (!speaking && this._isSpeaking) {
      this._lastSpeechEndTime = now;
      this._isSpeaking = false;
    }

    // ── Pitch (every Nth voiced frame) ──
    if (this._frameCount % PITCH_FRAME_SKIP === 0 && speaking) {
      const pitch = this._estimatePitch(buffer);
      if (pitch > 0) {
        this._pitchHistory.push(pitch);
        if (this._pitchHistory.length > PITCH_WINDOW_SIZE) this._pitchHistory.shift();
      }
    }
  }

  /** Call when a user transcript chunk arrives. */
  onTranscript(text) {
    if (!text?.trim()) return;
    const words = text.trim().split(/\s+/);
    const now = Date.now();
    for (const w of words) {
      if (w) this._wordTimestamps.push(now);
    }
    // Trim to window
    const cutoff = now - WORD_HISTORY_MS;
    this._wordTimestamps = this._wordTimestamps.filter(t => t > cutoff);
  }

  /**
   * Build a context injection string for Gemini.
   * Returns `null` if state is neutral/calm or cooldown hasn't elapsed.
   */
  maybeGetContextInjection() {
    if (this._frameCount < INJECT_MIN_FRAMES) return null;

    const now = Date.now();
    if (now - this._lastInjectTime < INJECT_COOLDOWN_MS) return null;

    const state = this._computeState();
    const signals = this._classifyEmotions(state);

    // Don't inject if calm/neutral
    if (signals.length === 0) return null;
    if (signals.length === 1 && (signals[0] === "calm" || signals[0] === "neutral")) return null;

    // Don't re-inject the same assessment
    const key = signals.sort().join(",");
    if (key === this._lastInjectKey) return null;

    this._lastInjectKey = key;
    this._lastInjectTime = now;

    return this._buildNaturalContext(signals, state);
  }

  /** Full reset for new session. */
  reset() { this._reset(); }

  // ── Internals ───────────────────────────────────────────────

  _reset() {
    this._rmsHistory = [];
    this._pitchHistory = [];
    this._wordTimestamps = [];
    this._silenceGaps = [];
    this._lastSpeechEndTime = 0;
    this._isSpeaking = false;
    this._frameCount = 0;
    this._lastInjectTime = 0;
    this._lastInjectKey = "";
  }

  // ── Pitch estimation (normalized autocorrelation) ──

  _estimatePitch(buf) {
    const n = buf.length;
    const minLag = Math.floor(this.sampleRate / 400); // 400 Hz ceiling
    const maxLag = Math.min(Math.floor(this.sampleRate / 70), n >>> 1); // 70 Hz floor

    let bestLag = 0;
    let bestCorr = 0;

    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0, n1 = 0, n2 = 0;
      for (let i = 0; i < n - lag; i++) {
        corr += buf[i] * buf[i + lag];
        n1  += buf[i] * buf[i];
        n2  += buf[i + lag] * buf[i + lag];
      }
      const norm = Math.sqrt(n1 * n2);
      if (norm > 0) corr /= norm;

      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }

    // Confidence gate — autocorrelation must exceed 0.35
    return (bestCorr > 0.35 && bestLag > 0) ? this.sampleRate / bestLag : 0;
  }

  // ── State computation ──

  _computeState() {
    return {
      energy:         this._energy(),
      volumeVariance: this._volumeVariance(),
      pitch:          this._pitchStats(),
      speakingRate:   this._speakingRate(),
      silencePattern: this._silencePattern(),
    };
  }

  _energy() {
    if (this._rmsHistory.length < 3) return "unknown";
    const avg = this._mean(this._rmsHistory);
    if (avg < 0.004) return "very_low";   // whispering
    if (avg < 0.012) return "low";
    if (avg < 0.035) return "normal";
    if (avg < 0.07)  return "high";
    return "very_high";                   // shouting
  }

  _volumeVariance() {
    if (this._rmsHistory.length < 5) return "unknown";
    const cv = this._coefficientOfVariation(this._rmsHistory);
    if (cv < 0.3) return "stable";
    if (cv < 0.6) return "moderate";
    return "erratic";                     // voice breaking / sobbing
  }

  _pitchStats() {
    if (this._pitchHistory.length < 3) return { level: "unknown", variance: "unknown" };
    const avg = this._mean(this._pitchHistory);
    const sd  = this._stddev(this._pitchHistory);

    let level;
    if (avg < 130)      level = "low";
    else if (avg < 200) level = "normal";
    else if (avg < 280) level = "high";
    else                level = "very_high";

    let variance;
    if (sd < 15)           variance = "monotone";
    else if (sd < 30)      variance = "stable";
    else if (sd < 55)      variance = "varied";
    else                   variance = "erratic";

    return { level, variance, avgHz: Math.round(avg) };
  }

  _speakingRate() {
    const now = Date.now();
    const recent = this._wordTimestamps.filter(t => t > now - 15_000);
    if (recent.length < 3) return "unknown";

    const span = (recent[recent.length - 1] - recent[0]) / 1000;
    if (span < 0.5) return "unknown";

    const wps = recent.length / span;
    if (wps < 1.2) return "very_slow";
    if (wps < 2.2) return "slow";
    if (wps < 3.8) return "normal";
    if (wps < 5.2) return "fast";
    return "very_fast";
  }

  _silencePattern() {
    if (this._silenceGaps.length < 2) return "unknown";
    const avg = this._mean(this._silenceGaps);
    if (avg > 5000) return "very_long_pauses";
    if (avg > 3000) return "long_pauses";
    if (avg > 1500) return "normal_pauses";
    if (avg > 500)  return "brief_pauses";
    return "no_pauses";                   // pressured speech
  }

  // ── Emotion classification (multi-signal) ──

  _classifyEmotions(s) {
    const out = [];

    // Crying / emotional breakdown — erratic volume + erratic pitch
    if (s.volumeVariance === "erratic" && s.pitch.variance === "erratic") {
      out.push("possibly_crying");
    } else if (s.volumeVariance === "erratic" && s.pitch.variance === "varied") {
      out.push("voice_breaking");
    }

    // Anger — loud + not slow
    if (s.energy === "very_high" && s.speakingRate !== "slow" && s.speakingRate !== "very_slow") {
      out.push("angry");
    } else if (s.energy === "high" && (s.speakingRate === "fast" || s.speakingRate === "very_fast")) {
      out.push("frustrated");
    }

    // Anxiety — fast + high pitch
    if ((s.speakingRate === "fast" || s.speakingRate === "very_fast") &&
        (s.pitch.level === "high" || s.pitch.level === "very_high")) {
      out.push("anxious");
    }

    // Sadness / depression — low energy + slow
    if ((s.energy === "low" || s.energy === "very_low") &&
        (s.speakingRate === "slow" || s.speakingRate === "very_slow")) {
      out.push("low_mood");
    }

    // Monotone + low = emotional flatness / numbness
    if (s.pitch.variance === "monotone" && (s.energy === "low" || s.energy === "very_low")) {
      out.push("emotionally_flat");
    }

    // Withdrawn — long pauses
    if (s.silencePattern === "very_long_pauses") {
      out.push("withdrawn");
    } else if (s.silencePattern === "long_pauses" && s.energy !== "high" && s.energy !== "very_high") {
      out.push("hesitant");
    }

    // Pressured speech — no pauses + fast = mania / panic
    if (s.silencePattern === "no_pauses" && (s.speakingRate === "fast" || s.speakingRate === "very_fast")) {
      out.push("pressured_speech");
    }

    // Fear — whispering + high pitch
    if (s.energy === "very_low" && (s.pitch.level === "high" || s.pitch.level === "very_high")) {
      out.push("fearful");
    }

    // Calm (explicit positive signal)
    if (out.length === 0) {
      if (s.energy === "normal" && s.volumeVariance === "stable" && s.pitch.variance !== "erratic") {
        out.push("calm");
      } else {
        out.push("neutral");
      }
    }

    return out;
  }

  // ── Build context string for LLM injection ──

  _buildNaturalContext(signals, state) {
    const parts = [];

    if (signals.includes("possibly_crying")) {
      parts.push("the user's voice is breaking and unsteady — they may be crying or deeply emotional");
    }
    if (signals.includes("voice_breaking")) {
      parts.push("the user's voice is shaking — they are emotionally overwhelmed");
    }
    if (signals.includes("angry")) {
      parts.push("the user is speaking loudly and intensely — they sound angry");
    }
    if (signals.includes("frustrated")) {
      parts.push("the user sounds frustrated — raised voice and fast pace");
    }
    if (signals.includes("anxious")) {
      parts.push("the user is speaking quickly with a higher-than-normal pitch — they sound anxious or panicked");
    }
    if (signals.includes("low_mood")) {
      parts.push("the user is speaking very quietly and slowly — they sound low, drained, or deeply sad");
    }
    if (signals.includes("emotionally_flat")) {
      parts.push("the user's voice is flat and monotone — they may be feeling numb or disconnected");
    }
    if (signals.includes("withdrawn")) {
      parts.push("there are very long silences between the user's words — they seem withdrawn or struggling to speak");
    }
    if (signals.includes("hesitant")) {
      parts.push("the user is pausing a lot — they seem hesitant or uncertain");
    }
    if (signals.includes("pressured_speech")) {
      parts.push("the user is speaking rapidly without pausing — this may indicate high stress or a panic state");
    }
    if (signals.includes("fearful")) {
      parts.push("the user is whispering with a strained voice — they may be scared or trying not to be heard by someone nearby");
    }

    if (parts.length === 0) return null;

    return (
      `[Vocal emotion observation: ${parts.join(". ")}. ` +
      `Adjust your tone and approach accordingly — be emotionally present, don't explicitly name the observation.]`
    );
  }

  // ── Math helpers ──

  _mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

  _stddev(arr) {
    const m = this._mean(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
  }

  _coefficientOfVariation(arr) {
    const m = this._mean(arr);
    return m > 0 ? this._stddev(arr) / m : 0;
  }
}
