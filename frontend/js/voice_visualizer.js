// frontend/js/voice_visualizer.js — Canvas 2D frequency visualizer for voice UI

const BIN_COUNT = 64;

// ═══════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════

let vizCanvas = null;
let vizCtx = null;
let animFrameId = null;
let smoothVolume = 0;
let blobPhase = 0;
let colorBlend = 0;
let currentPalette = "listen";
let smoothBins = null;
let isRunning = false;

// Analyser references (set by the session module)
let micAnalyser = null;
let micFreqData = null;
let aiAnalyser = null;
let aiFreqData = null;

// External state queries (injected)
let _isMicMuted = () => false;
let _isAiSpeaking = () => false;

// ═══════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════

export function startVisualizer({ isMicMuted, isAiSpeaking } = {}) {
  if (isMicMuted) _isMicMuted = isMicMuted;
  if (isAiSpeaking) _isAiSpeaking = isAiSpeaking;

  smoothVolume = 0;
  blobPhase = 0;
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
  smoothVolume = Math.max(smoothVolume, Math.min(1, rms * 14));
}

export function setPalette(id) {
  currentPalette = id === "speak" ? "speak" : "listen";
}

export function setAnalysers({ mic = null, ai = null } = {}) {
  if (mic) {
    micAnalyser = mic;
    micFreqData = new Uint8Array(mic.frequencyBinCount);
  } else {
    micAnalyser = null;
    micFreqData = null;
  }

  if (ai) {
    aiAnalyser = ai;
    aiFreqData = new Uint8Array(ai.frequencyBinCount);
  } else {
    aiAnalyser = null;
    aiFreqData = null;
  }

  smoothBins = new Float32Array(BIN_COUNT).fill(0);
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
// Frequency binning
// ═══════════════════════════════════════════════════════════════

function updateBins() {
  if (!smoothBins) return;

  let activeAnalyser = null;
  let activeFreqData = null;

  if (_isAiSpeaking() && aiAnalyser && aiFreqData) {
    activeAnalyser = aiAnalyser;
    activeFreqData = aiFreqData;
  } else if (!_isMicMuted() && micAnalyser && micFreqData) {
    activeAnalyser = micAnalyser;
    activeFreqData = micFreqData;
  }

  if (activeAnalyser && activeFreqData) {
    activeAnalyser.getByteFrequencyData(activeFreqData);
    const binSize = Math.floor(activeFreqData.length * 0.6 / BIN_COUNT);

    for (let i = 0; i < BIN_COUNT; i++) {
      let sum = 0;
      for (let j = 0; j < binSize; j++) {
        sum += activeFreqData[i * binSize + j];
      }
      const target = (sum / binSize) / 255;
      // Fast attack, slow decay for smooth visualization
      const speed = target > smoothBins[i] ? 0.35 : 0.12;
      smoothBins[i] += (target - smoothBins[i]) * speed;
    }
  } else {
    // No active analyser — decay all bins
    for (let i = 0; i < BIN_COUNT; i++) {
      smoothBins[i] *= 0.9;
      if (smoothBins[i] < 0.001) smoothBins[i] = 0;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Rendering
// ═══════════════════════════════════════════════════════════════

function computeColors() {
  const br = 59, bg = 130, bb = 246;
  const pr = 200, pg = 120, pb = 240;
  const bl = colorBlend * 0.6;

  return {
    r: Math.round(br + (pr - br) * bl),
    g: Math.round(bg + (pg - bg) * bl),
    b: Math.round(bb + (pb - bb) * bl),
  };
}

function drawVisualizer() {
  if (!vizCtx || !vizCanvas || !smoothBins) return;

  const W = vizCanvas.clientWidth;
  const H = vizCanvas.clientHeight;
  vizCtx.clearRect(0, 0, W, H);

  // Smoothly blend palette
  const blendTarget = currentPalette === "speak" ? 1 : 0;
  colorBlend += (blendTarget - colorBlend) * 0.04;

  updateBins();

  const { r: r1, g: g1, b: b1 } = computeColors();
  const t = blobPhase;

  // Responsive bar count
  const isPhone = W < 500;
  const isTablet = W >= 500 && W < 900;
  const barCount = isPhone ? 16 : isTablet ? 24 : 32;
  const barWidthPct = isPhone ? 0.85 : isTablet ? 0.75 : 0.6;
  const barSpacing = W * barWidthPct / barCount;
  const startX = W * (1 - barWidthPct) / 2;
  const maxBarH = H * (isPhone ? 0.25 : 0.35);

  for (let i = 0; i < barCount; i++) {
    const binIdx = Math.floor(i * (BIN_COUNT / barCount));
    const binVal = (smoothBins[binIdx] + (smoothBins[binIdx + 1] || 0)) * 0.5;

    // Mirror from center
    const centerDist = Math.abs(i - barCount / 2) / (barCount / 2);
    const centerBoost = 1 - centerDist * 0.3;

    const barH = binVal * maxBarH * centerBoost;
    if (barH < 2) continue;

    const x = startX + i * barSpacing + barSpacing / 2;
    const y = H;
    const ox = Math.sin(t * 0.8 + i * 0.3) * 2;
    const barX = x + ox;

    const glowW = barSpacing * 1.8;
    const glowH = barH * 1.4;

    const grad = vizCtx.createRadialGradient(
      barX, y, 0,
      barX, y - glowH * 0.4, Math.max(glowW, glowH)
    );

    const hueShift = Math.sin(i * 0.4 + t * 0.3) * 15;
    const cr = Math.min(255, r1 + hueShift);
    const cg = Math.min(255, g1 + hueShift * 0.5);
    const cb = Math.min(255, b1 - hueShift * 0.3);
    const alpha = 0.25 + binVal * 0.35;

    grad.addColorStop(0, `rgba(${cr},${cg},${cb},${alpha})`);
    grad.addColorStop(0.3, `rgba(${cr},${cg},${cb},${alpha * 0.5})`);
    grad.addColorStop(0.6, `rgba(${cr},${cg},${cb},${alpha * 0.15})`);
    grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);

    vizCtx.save();
    vizCtx.translate(barX, y);
    vizCtx.scale(1, glowH / Math.max(glowW, glowH));
    vizCtx.translate(-barX, -y);
    vizCtx.fillStyle = grad;
    vizCtx.fillRect(barX - glowW, y - glowH * 2, glowW * 2, glowH * 2);
    vizCtx.restore();
  }

  // Base glow
  const baseGrad = vizCtx.createRadialGradient(W / 2, H, 0, W / 2, H, W * 0.35);
  const totalE = smoothBins.reduce((a, b) => a + b, 0) / BIN_COUNT;
  baseGrad.addColorStop(0, `rgba(${r1},${g1},${b1},${0.1 + totalE * 0.15})`);
  baseGrad.addColorStop(0.5, `rgba(${r1},${g1},${b1},${0.03 + totalE * 0.05})`);
  baseGrad.addColorStop(1, `rgba(${r1},${g1},${b1},0)`);
  vizCtx.fillStyle = baseGrad;
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

  blobPhase += 0.012;
  smoothVolume *= 0.91;
  if (smoothVolume < 0.003) smoothVolume = 0;

  drawVisualizer();

  animFrameId = requestAnimationFrame(tick);
}
