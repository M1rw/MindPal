// frontend/js/voice_visualizer.js — Advanced fluid wave visualizer for voice UI

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

const WAVE_COUNT = 5;
const BIN_COUNT = 32;

// ═══════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════

let vizCanvas = null;
let vizCtx = null;
let animFrameId = null;
let smoothVolume = 0;
let phase = 0;
let colorBlend = 0;
let currentPalette = "listen";
let isRunning = false;

// Analyser references
let micAnalyser = null;
let micFreqData = null;
let aiAnalyser = null;
let aiFreqData = null;

// External state queries
let _isMicMuted = () => false;
let _isAiSpeaking = () => false;

// ═══════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════

export function startVisualizer({ isMicMuted, isAiSpeaking } = {}) {
  if (isMicMuted) _isMicMuted = isMicMuted;
  if (isAiSpeaking) _isAiSpeaking = isAiSpeaking;

  smoothVolume = 0;
  phase = 0;
  colorBlend = 0;
  currentPalette = "listen";
  isRunning = true;

  initCanvas();
  if (!animFrameId) tick();
}

export function stopVisualizer() {
  isRunning = false;
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  destroyCanvas();
}

export function feedVolume(rms) {
  // Faster attack, slower decay for volume reactivity
  const target = Math.max(0, Math.min(1, rms * 15));
  smoothVolume += (target - smoothVolume) * (target > smoothVolume ? 0.4 : 0.15);
}

export function setPalette(id) {
  currentPalette = id === "speak" ? "speak" : "listen";
}

export function setAnalysers({ mic = null, ai = null } = {}) {
  if (mic) {
    micAnalyser = mic;
    micFreqData = new Uint8Array(mic.frequencyBinCount);
  }
  if (ai) {
    aiAnalyser = ai;
    aiFreqData = new Uint8Array(ai.frequencyBinCount);
  }
}

// ═══════════════════════════════════════════════════════════════
// Canvas lifecycle
// ═══════════════════════════════════════════════════════════════

function initCanvas() {
  vizCanvas = document.getElementById("voice-wave-canvas");
  if (!vizCanvas) return;
  vizCtx = vizCanvas.getContext("2d");
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);
}

function resizeCanvas() {
  if (!vizCanvas) return;
  const dpr = window.devicePixelRatio || 1;
  vizCanvas.width = vizCanvas.clientWidth * dpr;
  vizCanvas.height = vizCanvas.clientHeight * dpr;
  vizCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function destroyCanvas() {
  window.removeEventListener("resize", resizeCanvas);
  vizCanvas = null;
  vizCtx = null;
}

// ═══════════════════════════════════════════════════════════════
// Rendering
// ═══════════════════════════════════════════════════════════════

function drawVisualizer() {
  if (!vizCtx || !vizCanvas) return;

  const W = vizCanvas.clientWidth;
  const H = vizCanvas.clientHeight;
  vizCtx.clearRect(0, 0, W, H);

  // Smoothly blend palette
  const blendTarget = currentPalette === "speak" ? 1 : 0;
  colorBlend += (blendTarget - colorBlend) * 0.05;

  // Base colors
  // Listen: Blue (#3b82f6)
  // Speak: Purple/Indigo (#8b5cf6)
  const r1 = 59 + (139 - 59) * colorBlend;
  const g1 = 130 + (92 - 130) * colorBlend;
  const b1 = 246 + (246 - 246) * colorBlend;

  const centerY = H * 0.75;
  const baseAmplitude = H * 0.1;
  const intensity = 0.1 + smoothVolume * 0.9;

  vizCtx.lineCap = "round";
  vizCtx.globalCompositeOperation = "lighter";

  for (let i = 0; i < WAVE_COUNT; i++) {
    const progress = i / WAVE_COUNT;
    const wavePhase = phase + i * 0.8;

    vizCtx.beginPath();
    vizCtx.lineWidth = 2 + (1 - progress) * 3;

    const alpha = (0.1 + (1 - progress) * 0.4) * intensity;
    vizCtx.strokeStyle = `rgba(${r1}, ${g1}, ${b1}, ${alpha})`;

    for (let x = 0; x <= W; x += 5) {
      // Create a complex wave using multiple sine components
      const normX = x / W;

      // Envelope to taper at edges
      const envelope = Math.sin(normX * Math.PI);

      let yOffset = Math.sin(normX * (2 + i) + wavePhase) * baseAmplitude;
      yOffset += Math.sin(normX * (5 + i * 0.5) - wavePhase * 0.5) * (baseAmplitude * 0.3);

      // Apply intensity and envelope
      const finalY = centerY + (yOffset * intensity * envelope);

      if (x === 0) vizCtx.moveTo(x, finalY);
      else vizCtx.lineTo(x, finalY);
    }
    vizCtx.stroke();
  }

  // Add a subtle glow at the bottom
  const grad = vizCtx.createRadialGradient(W / 2, H, 0, W / 2, H, W * 0.6);
  grad.addColorStop(0, `rgba(${r1}, ${g1}, ${b1}, ${0.15 * intensity})`);
  grad.addColorStop(1, `rgba(${r1}, ${g1}, ${b1}, 0)`);

  vizCtx.globalCompositeOperation = "source-over";
  vizCtx.fillStyle = grad;
  vizCtx.fillRect(0, 0, W, H);
}

// ═══════════════════════════════════════════════════════════════
// Animation loop
// ═══════════════════════════════════════════════════════════════

function tick() {
  if (!isRunning) {
    animFrameId = null;
    return;
  }

  // Speed up when someone is speaking
  const speed = 0.02 + smoothVolume * 0.08;
  phase += speed;

  // Natural volume decay
  smoothVolume *= 0.92;
  if (smoothVolume < 0.001) smoothVolume = 0;

  drawVisualizer();

  animFrameId = requestAnimationFrame(tick);
}
