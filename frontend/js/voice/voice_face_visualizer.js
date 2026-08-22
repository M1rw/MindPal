const DEFAULT_STATE = Object.freeze({
  phase: "idle",
  isAiSpeaking: false,
  isMicMuted: false,
  isSpeakerMuted: false,
  interactionTag: "",
  backgroundTaskActive: false,
  error: false,
});

const EXPRESSION_TARGETS = Object.freeze({
  neutral: { width: 24, height: 50, spacing: 72, angle: 0, offsetY: -34, leftScale: 1, rightScale: 1, gazeX: 0, gazeY: 0 },
  listening: { width: 26, height: 58, spacing: 76, angle: 0, offsetY: -32, leftScale: 1.06, rightScale: 1.06, gazeX: 0, gazeY: 0 },
  speaking: { width: 24, height: 50, spacing: 72, angle: 0, offsetY: -35, leftScale: 1, rightScale: 1, gazeX: 0, gazeY: 0 },
  thinking: { width: 21, height: 40, spacing: 64, angle: 5, offsetY: -38, leftScale: 0.94, rightScale: 1.06, gazeX: 0, gazeY: -4 },
  backchannel: { width: 27, height: 43, spacing: 74, angle: -5, offsetY: -35, leftScale: 0.88, rightScale: 0.88, gazeX: 0, gazeY: 0 },
  muted: { width: 24, height: 17, spacing: 70, angle: 0, offsetY: -27, leftScale: 0.42, rightScale: 0.42, gazeX: 0, gazeY: 7 },
  connecting: { width: 19, height: 34, spacing: 58, angle: 0, offsetY: -34, leftScale: 0.85, rightScale: 0.85, gazeX: 0, gazeY: 0 },
  error: { width: 22, height: 42, spacing: 68, angle: 8, offsetY: -35, leftScale: 0.78, rightScale: 1.08, gazeX: 0, gazeY: 3 },
});

const EXPRESSION_LABELS = Object.freeze({
  neutral: "Ready",
  listening: "Listening",
  speaking: "MindPal is speaking",
  thinking: "Thinking",
  backchannel: "Responding briefly",
  muted: "Microphone muted",
  connecting: "Connecting",
  error: "Voice connection error",
});

const COLORS = Object.freeze({
  neutral: [75, 142, 244],
  listening: [81, 163, 244],
  speaking: [178, 116, 240],
  thinking: [128, 120, 239],
  backchannel: [231, 141, 190],
  muted: [125, 137, 160],
  connecting: [83, 135, 232],
  error: [224, 102, 119],
});

class SpringValue {
  constructor(value, stiffness = 0.12, damping = 0.78) {
    this.current = value;
    this.target = value;
    this.velocity = 0;
    this.stiffness = stiffness;
    this.damping = damping;
  }

  set(value) {
    this.target = value;
  }

  update() {
    const force = (this.target - this.current) * this.stiffness;
    this.velocity = (this.velocity + force) * this.damping;
    this.current += this.velocity;
    return this.current;
  }

  snap(value) {
    this.current = value;
    this.target = value;
    this.velocity = 0;
  }
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
}

function normalizeTag(tag) {
  return String(tag || "").toLowerCase().replace(/[_-]+/g, " ");
}

/**
 * Pure state bridge used by the renderer and unit tests. It only accepts state
 * emitted by MindPal Voice; it does not infer speech from a second microphone.
 */
export function deriveVoiceFaceState({
  phase = "idle",
  isAiSpeaking = false,
  isMicMuted = false,
  isSpeakerMuted = false,
  interactionTag = "",
  backgroundTaskActive = false,
  error = false,
  micLevel = 0,
} = {}) {
  const normalizedPhase = String(phase || "idle").toLowerCase();
  const tag = normalizeTag(interactionTag);
  let expression = "neutral";

  if (error || ["error", "failed", "provider-error"].includes(normalizedPhase)) {
    expression = "error";
  } else if (tag.includes("backchannel") || tag.includes("cue")) {
    expression = "backchannel";
  } else if (Boolean(isAiSpeaking) || normalizedPhase === "speaking") {
    expression = "speaking";
  } else if (backgroundTaskActive || ["thinking", "preparing", "interrupting", "holding"].includes(normalizedPhase)) {
    expression = "thinking";
  } else if (["connecting", "recovering"].includes(normalizedPhase)) {
    expression = "connecting";
  } else if (isMicMuted) {
    expression = "muted";
  } else if (["listening", "attending"].includes(normalizedPhase)) {
    expression = clamp(micLevel) >= 0.065 ? "listening" : "neutral";
  }

  return {
    expression,
    phase: normalizedPhase,
    isAiSpeaking: Boolean(isAiSpeaking),
    isMicMuted: Boolean(isMicMuted),
    isSpeakerMuted: Boolean(isSpeakerMuted),
    label: EXPRESSION_LABELS[expression],
  };
}

function readAnalyserLevel(analyser, data) {
  if (!analyser || !data || typeof analyser.getByteFrequencyData !== "function") return 0;
  analyser.getByteFrequencyData(data);
  const start = Math.min(3, data.length);
  const end = Math.max(start + 1, Math.floor(data.length * 0.72));
  let sum = 0;
  for (let index = start; index < end; index += 1) sum += data[index];
  return clamp((sum / Math.max(1, end - start)) / 150, 0, 1);
}

function roundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

class VoiceFaceRenderer {
  constructor(canvas, labelElement) {
    this.canvas = canvas;
    this.ctx = canvas?.getContext?.("2d") || null;
    this.labelElement = labelElement || null;
    this.container = canvas?.parentElement || null;
    this.running = false;
    this.frameId = null;
    this.resizeObserver = null;
    this.onVisibilityChange = () => this.handleVisibilityChange();
    this.onWindowResize = () => this.resize();
    this.reducedMotion = Boolean(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.time = 0;
    this.lastFrameAt = 0;
    this.expression = "neutral";
    this.state = { ...DEFAULT_STATE };
    this.micLevel = new SpringValue(0, 0.22, 0.82);
    this.aiLevel = new SpringValue(0, 0.2, 0.84);
    this.pulse = new SpringValue(0, 0.2, 0.78);
    this.color = [75, 142, 244];
    this.colorTarget = [...this.color];
    this.orbRadius = 142;
    this.micAnalyser = null;
    this.aiAnalyser = null;
    this.micData = null;
    this.aiData = null;
    this.lastDiagnostic = null;
    this.backchannelUntil = 0;
  }

  start() {
    if (!this.canvas || !this.ctx) return false;
    this.running = true;
    this.resize();
    document.addEventListener?.("visibilitychange", this.onVisibilityChange);
    window.addEventListener?.("resize", this.onWindowResize, { passive: true });
    if (this.container && typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.container);
    }
    if (this.frameId === null && !document.hidden) this.frameId = requestAnimationFrame((now) => this.render(now));
    this.updateLabel();
    return true;
  }

  stop() {
    this.running = false;
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.frameId = null;
    document.removeEventListener?.("visibilitychange", this.onVisibilityChange);
    window.removeEventListener?.("resize", this.onWindowResize);
    this.resizeObserver?.disconnect?.();
    this.resizeObserver = null;
    this.ctx?.clearRect(0, 0, this.width, this.height);
  }

  dispose() {
    this.stop();
    this.canvas = null;
    this.ctx = null;
    this.container = null;
    this.labelElement = null;
  }

  setState(nextState = {}) {
    this.state = { ...this.state, ...nextState };
    const mapped = deriveVoiceFaceState({ ...this.state, micLevel: this.micLevel.target });
    if (mapped.expression !== this.expression) {
      this.expression = mapped.expression;
      this.pulse.set(this.expression === "error" ? 0.75 : this.expression === "backchannel" ? 0.58 : 0.25);
      this.colorTarget = [...(COLORS[this.expression] || COLORS.neutral)];
      this.updateLabel(mapped.label);
    }
    return mapped;
  }

  setDiagnostic(event = {}) {
    this.lastDiagnostic = event;
    const type = String(event.type || "");
    const audioClass = String(event.audioClass || "");
    if (audioClass === "backchannel" || type.includes("backchannel")) {
      this.backchannelUntil = Date.now() + 850;
      this.setState({ interactionTag: "backchannel" });
      return;
    }
    if (["provider.error", "voice.socket-error", "voice.provider-error", "transport.error"].includes(type)) {
      this.setState({ phase: "error", error: true });
    }
  }

  feedMicLevel(rms) {
    const level = clamp(Number(rms) * 14, 0, 1);
    this.micLevel.set(level);
    if (this.state.phase === "listening" || this.state.phase === "attending") {
      const mapped = deriveVoiceFaceState({ ...this.state, micLevel: level });
      if (mapped.expression !== this.expression) {
        this.expression = mapped.expression;
        this.updateLabel(mapped.label);
      }
    }
  }

  setAnalysers({ mic = null, ai = null } = {}) {
    this.micAnalyser = mic;
    this.aiAnalyser = ai;
    this.micData = mic ? new Uint8Array(mic.frequencyBinCount || 128) : null;
    this.aiData = ai ? new Uint8Array(ai.frequencyBinCount || 128) : null;
  }

  resize() {
    if (!this.canvas || !this.ctx) return;
    const rect = this.container?.getBoundingClientRect?.() || this.canvas.getBoundingClientRect?.() || { width: 0, height: 0 };
    this.width = Math.max(1, rect.width || this.canvas.clientWidth || window.innerWidth || 1);
    this.height = Math.max(1, rect.height || this.canvas.clientHeight || window.innerHeight || 1);
    this.dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.orbRadius = Math.min(170, Math.max(86, Math.min(this.width, this.height) * 0.19));
  }

  handleVisibilityChange() {
    if (!this.running) return;
    if (document.hidden) {
      if (this.frameId !== null) cancelAnimationFrame(this.frameId);
      this.frameId = null;
    } else if (this.frameId === null) {
      this.frameId = requestAnimationFrame((now) => this.render(now));
    }
  }

  updateLabel(label = EXPRESSION_LABELS[this.expression]) {
    if (!this.labelElement) return;
    this.labelElement.textContent = label;
  }

  update() {
    const now = Date.now();
    if (this.backchannelUntil && now >= this.backchannelUntil) {
      this.backchannelUntil = 0;
      this.setState({ interactionTag: "" });
    }
    const analyserMicLevel = this.state.isMicMuted ? 0 : readAnalyserLevel(this.micAnalyser, this.micData);
    const analyserAiLevel = this.state.isSpeakerMuted ? 0 : readAnalyserLevel(this.aiAnalyser, this.aiData);
    this.micLevel.set(Math.max(this.micLevel.target * 0.94, analyserMicLevel));
    this.aiLevel.set(analyserAiLevel);
    this.micLevel.update();
    this.aiLevel.update();
    this.pulse.set(this.expression === "speaking" ? 0.36 + this.aiLevel.current * 0.9 : this.expression === "listening" ? this.micLevel.current * 0.72 : this.pulse.target * 0.98);
    this.pulse.update();
    this.color = this.color.map((channel, index) => channel + (this.colorTarget[index] - channel) * 0.045);
  }

  render(now = 0) {
    this.frameId = null;
    if (!this.running || !this.ctx || !this.canvas || document.hidden) return;
    const elapsed = this.lastFrameAt ? Math.min(64, now - this.lastFrameAt) : 16;
    this.lastFrameAt = now;
    this.time += (elapsed / 1000) * (this.reducedMotion ? 0.18 : 1);
    this.update();
    this.draw();
    this.frameId = requestAnimationFrame((nextNow) => this.render(nextNow));
  }

  draw() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const cx = w / 2;
    const cy = h * 0.52;
    const [r, g, b] = this.color.map(Math.round);
    const energy = clamp(Math.max(this.micLevel.current, this.aiLevel.current));
    const floatY = this.reducedMotion ? 0 : Math.sin(this.time * 1.15) * Math.min(5, this.orbRadius * 0.035);
    const radius = this.orbRadius * (1 + this.pulse.current * 0.055 + energy * 0.05);

    ctx.clearRect(0, 0, w, h);
    const background = ctx.createRadialGradient(cx, cy + floatY, radius * 0.1, cx, cy + floatY, Math.max(w, h) * 0.72);
    background.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${0.06 + energy * 0.08})`);
    background.addColorStop(0.48, `rgba(${r}, ${g}, ${b}, 0.025)`);
    background.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(cx, cy + floatY);
    ctx.globalCompositeOperation = "screen";
    for (let ring = 0; ring < 3; ring += 1) {
      const ringRadius = radius * (1.09 + ring * 0.11) + Math.sin(this.time * 1.5 + ring) * (this.reducedMotion ? 0 : 2.5);
      ctx.beginPath();
      ctx.arc(0, 0, ringRadius, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${0.10 - ring * 0.022 + energy * 0.08})`;
      ctx.lineWidth = 1.2;
      ctx.shadowBlur = 13;
      ctx.shadowColor = `rgba(${r}, ${g}, ${b}, 0.24)`;
      ctx.stroke();
    }

    const orb = ctx.createRadialGradient(-radius * 0.32, -radius * 0.38, radius * 0.08, 0, 0, radius * 1.2);
    orb.addColorStop(0, "rgba(255, 255, 255, 0.92)");
    orb.addColorStop(0.17, `rgba(${Math.min(255, r + 72)}, ${Math.min(255, g + 78)}, 255, 0.8)`);
    orb.addColorStop(0.52, `rgba(${r}, ${g}, ${b}, 0.54)`);
    orb.addColorStop(0.86, `rgba(${Math.max(40, r - 25)}, ${Math.max(50, g - 35)}, ${Math.min(255, b + 4)}, 0.24)`);
    orb.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    ctx.fillStyle = orb;
    ctx.shadowBlur = 26 + energy * 24;
    ctx.shadowColor = `rgba(${r}, ${g}, ${b}, 0.32)`;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    this.drawEyes(ctx, radius, r, g, b, energy);
    ctx.restore();
  }

  drawEyes(ctx, radius, r, g, b, energy) {
    const target = EXPRESSION_TARGETS[this.expression] || EXPRESSION_TARGETS.neutral;
    const scale = radius / 142;
    const gazeX = target.gazeX + (this.expression === "connecting" ? Math.sin(this.time * 1.7) * 18 : 0);
    const gazeY = target.gazeY + (this.expression === "connecting" ? Math.cos(this.time * 1.7) * 9 : 0);
    const eyeWidth = target.width * scale;
    const eyeHeight = target.height * scale * (1 + energy * (this.expression === "speaking" ? 0.16 : 0.05));
    const eyeY = target.offsetY * scale + gazeY * scale;
    const spacing = target.spacing * scale;
    const blink = this.reducedMotion ? 1 : 0.985 + Math.sin(this.time * 0.73) * 0.015;
    const alpha = this.state.isSpeakerMuted && this.expression === "speaking" ? 0.45 : 0.96;

    ctx.save();
    ctx.translate(gazeX * scale, 0);
    ctx.rotate((target.angle * Math.PI) / 180);
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.shadowBlur = 15;
    ctx.shadowColor = `rgba(${r}, ${g}, ${b}, 0.42)`;
    const leftHeight = eyeHeight * target.leftScale * blink;
    const rightHeight = eyeHeight * target.rightScale * blink;
    roundedRectPath(ctx, -spacing / 2 - eyeWidth / 2, eyeY - leftHeight / 2, eyeWidth, Math.max(2, leftHeight), eyeWidth / 2);
    ctx.fill();
    roundedRectPath(ctx, spacing / 2 - eyeWidth / 2, eyeY - rightHeight / 2, eyeWidth, Math.max(2, rightHeight), eyeWidth / 2);
    ctx.fill();
    ctx.restore();
  }
}

let renderer = null;
let state = { ...DEFAULT_STATE };
let micMutedQuery = () => Boolean(state.isMicMuted);
let aiSpeakingQuery = () => Boolean(state.isAiSpeaking);

export function initVoiceFace({ canvasId = "voice-face-canvas", labelId = "voice-face-state-label" } = {}) {
  const canvas = document.getElementById(canvasId);
  const label = document.getElementById(labelId);
  if (!canvas) return false;
  renderer?.dispose?.();
  renderer = new VoiceFaceRenderer(canvas, label);
  renderer.setState(state);
  return true;
}

export function startVoiceFace({ isMicMuted, isAiSpeaking } = {}) {
  if (isMicMuted) micMutedQuery = isMicMuted;
  if (isAiSpeaking) aiSpeakingQuery = isAiSpeaking;
  if (!renderer) initVoiceFace();
  state = { ...state, isMicMuted: Boolean(micMutedQuery()), isAiSpeaking: Boolean(aiSpeakingQuery()) };
  renderer?.setState(state);
  return renderer?.start?.() || false;
}

export function stopVoiceFace() {
  renderer?.stop?.();
}

export function disposeVoiceFace() {
  renderer?.dispose?.();
  renderer = null;
}

export function setVoiceFaceState(nextState = {}) {
  state = { ...state, ...nextState };
  if (renderer) return renderer.setState(state);
  return deriveVoiceFaceState({ ...state, micLevel: 0 });
}

export function setVoiceFaceDiagnostic(event = {}) {
  renderer?.setDiagnostic?.(event);
}

export function feedVoiceFaceMicLevel(rms) {
  renderer?.feedMicLevel?.(rms);
  state = { ...state, micLevel: Number(rms) || 0 };
}

export function feedVoiceFaceAiLevel(level) {
  renderer?.aiLevel?.set?.(clamp(level));
}

export function setVoiceFaceAnalysers({ mic = null, ai = null } = {}) {
  renderer?.setAnalysers?.({ mic, ai });
}

export function getVoiceFaceSnapshot() {
  return {
    ...deriveVoiceFaceState({ ...state, micLevel: renderer?.micLevel?.current || 0 }),
    running: Boolean(renderer?.running),
    micLevel: renderer?.micLevel?.current || 0,
    aiLevel: renderer?.aiLevel?.current || 0,
    lastDiagnostic: renderer?.lastDiagnostic || null,
  };
}
