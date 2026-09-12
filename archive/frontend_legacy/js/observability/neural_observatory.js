import { readRecentNeuralEvents } from "./neural_telemetry.js";

const CHANNEL_NAME = "mindpal-neural-observatory-v1";
const STAGES = ["request", "tokenize", "attention", "activation", "sae", "feature_graph", "response"];
const STAGE_COPY = {
  request: ["REQUEST EVENT", "A private local request signal entered the visual field."],
  tokenize: ["TOKENIZATION", "Input has been reduced to coarse processing units."],
  attention: ["ATTENTION HEADS", "Attention paths are propagating across the transformer stack."],
  activation: ["ACTIVATION FIELD", "Layer activity is energizing the neural field."],
  sae: ["SAE FEATURE EXTRACTION", "Dense activity is decomposing into sparse feature signals."],
  feature_graph: ["FEATURE RELATIONSHIPS", "Active sparse features are forming transient graph paths."],
  response: ["RESPONSE STREAM", "The response stage is emitting back through the field."],
  error: ["RECOVERY FIELD", "The visual field is settling after an interrupted request."],
  idle: ["IDLE FIELD", "Running a local visual simulation."],
};
const FEATURE_LABELS = [
  "F-0184 · context continuity", "F-0721 · intent framing", "F-1298 · safety routing",
  "F-2216 · semantic relation", "F-3184 · response planning", "F-4092 · uncertainty gate",
  "F-5177 · emotional tone", "F-6031 · language structure", "F-7540 · memory cue",
];
const LAYER_COLORS = [
  [0.25, 0.75, 1.0], [0.35, 0.62, 1.0], [0.45, 0.48, 1.0],
  [0.64, 0.42, 1.0], [0.82, 0.44, 0.95], [0.25, 0.86, 0.70], [0.95, 0.73, 0.33],
];

let renderer = null;
let paused = false;
let density = 2;
let currentStage = "idle";
let lastLiveEventAt = 0;
let idleTimer = null;
let channel = null;

window.addEventListener("DOMContentLoaded", initializeObservatory);

function initializeObservatory() {
  renderer = new NeuralField(document.getElementById("neural-webgl-canvas"));
  if (!renderer.ready) document.getElementById("neural-canvas-fallback").hidden = false;
  bindControls();
  bindLocalTelemetry();
  renderFeatures("idle");
  activateStage(readRecentNeuralEvents().at(-1)?.stage || "idle", { live: false });
  idleTimer = window.setInterval(runIdlePulse, 2300);
}

function bindControls() {
  document.getElementById("neural-pause-toggle")?.addEventListener("click", (event) => {
    paused = !paused;
    event.currentTarget.setAttribute("aria-pressed", String(paused));
    event.currentTarget.textContent = paused ? "Resume field" : "Pause field";
    renderer?.setPaused(paused);
  });
  document.getElementById("neural-density")?.addEventListener("input", (event) => {
    density = Number(event.currentTarget.value || 2);
    renderer?.rebuild(density);
  });
  document.getElementById("neural-trigger-button")?.addEventListener("click", () => {
    STAGES.forEach((stage, index) => window.setTimeout(() => activateStage(stage, { live: false }), index * 360));
  });
}

function bindLocalTelemetry() {
  if (typeof BroadcastChannel === "undefined") return;
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.addEventListener("message", (event) => {
    const payload = event.data;
    if (payload?.kind !== "mindpal_neural_stage" || !STAGES.includes(payload.stage)) return;
    lastLiveEventAt = Date.now();
    activateStage(payload.stage, { live: true });
    if (payload.stage === "activation") window.setTimeout(() => activateStage("sae", { live: true }), 260);
  });
}

function runIdlePulse() {
  if (Date.now() - lastLiveEventAt < 5200 || paused) return;
  const next = STAGES[(STAGES.indexOf(currentStage) + 1) % STAGES.length];
  activateStage(next, { live: false });
}

function activateStage(stage, { live }) {
  currentStage = STAGES.includes(stage) ? stage : "idle";
  const [label, detail] = STAGE_COPY[currentStage] || STAGE_COPY.idle;
  const stageTarget = document.getElementById("observatory-stage");
  const detailTarget = document.getElementById("observatory-stage-detail");
  const modeTarget = document.getElementById("event-mode-label");
  if (stageTarget) stageTarget.textContent = label;
  if (detailTarget) detailTarget.textContent = detail;
  if (modeTarget) modeTarget.textContent = live ? "LIVE MINDPAL EVENT" : "IDLE SIMULATION";
  document.querySelectorAll("#transformer-pipeline [data-stage]").forEach((element) => {
    element.classList.toggle("active", element.dataset.stage === currentStage);
    element.classList.toggle("passed", STAGES.indexOf(element.dataset.stage) < STAGES.indexOf(currentStage));
  });
  renderer?.pulse(STAGES.indexOf(currentStage), live ? 1 : 0.65);
  renderFeatures(currentStage);
}

function renderFeatures(stage) {
  const container = document.getElementById("feature-readout");
  const countTarget = document.getElementById("active-feature-count");
  const propagationTarget = document.getElementById("propagation-rate");
  if (!container) return;
  const phase = Math.max(0, STAGES.indexOf(stage));
  const features = Array.from({ length: 5 }, (_, index) => {
    const featureIndex = (phase * 3 + index * 2) % FEATURE_LABELS.length;
    const value = (0.91 - index * 0.105 - (phase % 3) * 0.012).toFixed(2);
    return `<div class="feature-row"><span>${FEATURE_LABELS[featureIndex]}</span><b>${value}</b><i style="--feature-width:${Math.round(Number(value) * 100)}%"></i></div>`;
  });
  container.innerHTML = features.join("");
  if (countTarget) countTarget.textContent = String(118 + phase * 37 + density * 22);
  if (propagationTarget) propagationTarget.textContent = `${(18 + phase * 7 + density * 4).toFixed(1)} Hz`;
}

class NeuralField {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas?.getContext?.("webgl", { antialias: true, alpha: false, preserveDrawingBuffer: false }) || null;
    this.ready = Boolean(this.gl);
    this.nodes = [];
    this.edges = [];
    this.energy = 0.55;
    this.focusLayer = 0;
    this.paused = false;
    this.lastFrame = performance.now();
    if (!this.ready) return;
    this.pointProgram = createProgram(this.gl, POINT_VERTEX, POINT_FRAGMENT);
    this.lineProgram = createProgram(this.gl, LINE_VERTEX, LINE_FRAGMENT);
    this.pointBuffer = this.gl.createBuffer();
    this.lineBuffer = this.gl.createBuffer();
    this.resize = this.resize.bind(this);
    window.addEventListener("resize", this.resize, { passive: true });
    this.resize();
    this.rebuild(density);
    requestAnimationFrame((now) => this.draw(now));
  }

  setPaused(value) { this.paused = value; }

  rebuild(nextDensity) {
    if (!this.ready) return;
    const multiplier = [0.58, 1, 1.55][Math.max(0, Math.min(2, nextDensity - 1))];
    const baseCounts = [14, 21, 30, 35, 30, 22, 15];
    this.nodes = [];
    this.edges = [];
    baseCounts.forEach((base, layer) => {
      const count = Math.round(base * multiplier);
      for (let index = 0; index < count; index += 1) {
        const seed = seeded(layer * 97 + index * 13);
        this.nodes.push({
          layer, index, x: -0.86 + layer * 0.286, y: -0.79 + seed * 1.58,
          phase: seed * Math.PI * 2, size: 2.2 + seeded(index * 31 + layer) * 2.7,
          color: LAYER_COLORS[layer], signal: seeded(index * 9 + layer * 7),
        });
      }
    });
    for (let layer = 0; layer < baseCounts.length - 1; layer += 1) {
      const left = this.nodes.filter((node) => node.layer === layer);
      const right = this.nodes.filter((node) => node.layer === layer + 1);
      left.forEach((node, index) => {
        const first = right[(index * 7 + layer * 3) % right.length];
        const second = right[(index * 11 + 5) % right.length];
        this.edges.push([node, first]);
        if (index % 3 === 0) this.edges.push([node, second]);
      });
    }
  }

  resize() {
    if (!this.ready) return;
    const bounds = this.canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(bounds.width * ratio));
    this.canvas.height = Math.max(1, Math.round(bounds.height * ratio));
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  pulse(layer, strength) {
    this.focusLayer = Math.max(0, layer);
    this.energy = Math.max(this.energy, strength);
  }

  draw(now) {
    if (!this.ready) return;
    const elapsed = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (!this.paused) this.energy = Math.max(0.45, this.energy - elapsed * 0.12);
    const time = now / 1000;
    const gl = this.gl;
    gl.clearColor(0.016, 0.025, 0.06, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawLines(time);
    this.drawPoints(time);
    requestAnimationFrame((next) => this.draw(next));
  }

  drawLines(time) {
    const values = new Float32Array(this.edges.length * 10);
    let offset = 0;
    this.edges.forEach(([from, to], index) => {
      const activity = lineActivity(from, to, this.focusLayer, this.energy, time, index);
      [[from, from.color], [to, to.color]].forEach(([node, color]) => {
        values[offset++] = node.x;
        values[offset++] = node.y + Math.sin(time * .7 + node.phase) * .012;
        values[offset++] = color[0] * activity;
        values[offset++] = color[1] * activity;
        values[offset++] = color[2] * activity;
      });
    });
    const gl = this.gl;
    gl.useProgram(this.lineProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, values, gl.DYNAMIC_DRAW);
    bindLineAttributes(gl, this.lineProgram);
    gl.drawArrays(gl.LINES, 0, this.edges.length * 2);
  }

  drawPoints(time) {
    const values = new Float32Array(this.nodes.length * 6);
    let offset = 0;
    this.nodes.forEach((node, index) => {
      const activity = nodeActivity(node, this.focusLayer, this.energy, time, index);
      values[offset++] = node.x;
      values[offset++] = node.y + Math.sin(time * .72 + node.phase) * .012;
      values[offset++] = node.color[0] * activity;
      values[offset++] = node.color[1] * activity;
      values[offset++] = node.color[2] * activity;
      values[offset++] = node.size + activity * 3.2;
    });
    const gl = this.gl;
    gl.useProgram(this.pointProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, values, gl.DYNAMIC_DRAW);
    bindPointAttributes(gl, this.pointProgram);
    gl.drawArrays(gl.POINTS, 0, this.nodes.length);
  }
}

function bindLineAttributes(gl, program) {
  const stride = 5 * 4;
  const position = gl.getAttribLocation(program, "a_position");
  const color = gl.getAttribLocation(program, "a_color");
  gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(color); gl.vertexAttribPointer(color, 3, gl.FLOAT, false, stride, 8);
}

function bindPointAttributes(gl, program) {
  const stride = 6 * 4;
  const position = gl.getAttribLocation(program, "a_position");
  const color = gl.getAttribLocation(program, "a_color");
  const size = gl.getAttribLocation(program, "a_size");
  gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(color); gl.vertexAttribPointer(color, 3, gl.FLOAT, false, stride, 8);
  gl.enableVertexAttribArray(size); gl.vertexAttribPointer(size, 1, gl.FLOAT, false, stride, 20);
}

function createProgram(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  [compileShader(gl, gl.VERTEX_SHADER, vertexSource), compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource)].forEach((shader) => gl.attachShader(program, shader));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("Neural WebGL program failed to link.");
  return program;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || "Neural shader compilation failed.");
  return shader;
}

function nodeActivity(node, focusLayer, energy, time, index) {
  const distance = Math.abs(node.layer - focusLayer);
  const focus = Math.exp(-distance * 1.05) * energy;
  return Math.min(1.18, .38 + focus + Math.sin(time * (1.1 + node.signal) + index) * .12);
}

function lineActivity(from, to, focusLayer, energy, time, index) {
  const midLayer = (from.layer + to.layer) / 2;
  const distance = Math.abs(midLayer - focusLayer);
  return Math.min(.9, .14 + Math.exp(-distance * .86) * energy * .58 + Math.sin(time * 1.4 + index * .21) * .07);
}

function seeded(value) {
  const result = Math.sin(value * 12.9898) * 43758.5453;
  return result - Math.floor(result);
}

const LINE_VERTEX = `attribute vec2 a_position; attribute vec3 a_color; varying vec3 v_color; void main(){gl_Position=vec4(a_position,0.0,1.0);v_color=a_color;}`;
const LINE_FRAGMENT = `precision mediump float; varying vec3 v_color; void main(){gl_FragColor=vec4(v_color,0.45);}`;
const POINT_VERTEX = `attribute vec2 a_position; attribute vec3 a_color; attribute float a_size; varying vec3 v_color; void main(){gl_Position=vec4(a_position,0.0,1.0);gl_PointSize=a_size;v_color=a_color;}`;
const POINT_FRAGMENT = `precision mediump float; varying vec3 v_color; void main(){vec2 p=gl_PointCoord-vec2(.5);float d=length(p);if(d>.5) discard;float glow=smoothstep(.5,0.0,d);gl_FragColor=vec4(v_color,glow);}`;
