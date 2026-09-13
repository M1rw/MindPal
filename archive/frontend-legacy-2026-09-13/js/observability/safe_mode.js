import { readLastSafeModeRuntimeTrace } from "./neural_telemetry.js";

const CHANNEL = "mindpal-neural-observatory-v1";
const ORDER = [
  "input",
  "session",
  "guardrails",
  "context",
  "memory",
  "retrieval",
  "tool_router",
  "web",
  "time",
  "memory_search",
  "model",
  "evaluator",
  "synthesis",
  "output",
  "error",
];
const POSITIONS = {
  input: [72, 210],
  session: [165, 210],
  guardrails: [260, 210],
  context: [355, 210],
  memory: [445, 145],
  retrieval: [445, 275],
  tool_router: [545, 210],
  web: [640, 120],
  time: [640, 210],
  memory_search: [640, 300],
  model: [760, 210],
  evaluator: [875, 210],
  synthesis: [980, 210],
  output: [1105, 210],
  error: [1010, 330],
};

let trace = null;
let paused = false;
let startAt = performance.now();
let selectedNode = null;
let demoTimer = null;

window.addEventListener("DOMContentLoaded", init);

function init() {
  bind();
  setupMobileTabs();

  const initialTrace = readLastSafeModeRuntimeTrace();
  if (initialTrace) {
    applyTrace(initialTrace);
  } else {
    // Show empty state placeholder or default UI state
    document.body.setAttribute("data-active-tab", "graph");
  }

  setInterval(updateUptime, 1000);

  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(CHANNEL);
    channel.addEventListener("message", (event) => {
      if (event.data?.kind === "mindpal_safe_mode_trace") {
        applyTrace(event.data.trace);
      } else if (event.data?.kind === "mindpal_neural_stage") {
        showLocalStage(event.data);
      }
    });
  }
}

function bind() {
  document.getElementById("safe-pause")?.addEventListener("click", (event) => {
    paused = !paused;
    event.currentTarget.setAttribute("aria-pressed", String(paused));
    event.currentTarget.textContent = paused ? "RESUME" : "PAUSE";
    document.querySelectorAll(".safe-edge.active").forEach((edge) => {
      edge.classList.toggle("paused", paused);
    });
  });

  document.getElementById("safe-demo-btn")?.addEventListener("click", () => {
    runDemoTrace();
  });
}

function setupMobileTabs() {
  const tabs = document.querySelectorAll(".safe-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const target = tab.dataset.tab;
      document.body.setAttribute("data-active-tab", target);
    });
  });
}

function applyTrace(next) {
  if (!next || !Array.isArray(next.events)) return;
  trace = next;
  selectedNode = null;

  const emptyEl = document.getElementById("safe-graph-empty");
  if (emptyEl) emptyEl.style.display = "none";

  const run = String(trace.run_id || "—");
  setText("safe-run-id", run);
  setText("safe-run-short", run.slice(-7) || "—");
  setText("safe-event-count", String(trace.events.length));
  setText("safe-latency", trace.total_duration_ms ? `${trace.total_duration_ms}ms` : "—");
  setText("safe-status", trace.completed ? "ONLINE" : "RUNNING");
  setText("safe-top-status", trace.completed ? "ONLINE" : "RUNNING");
  setText("safe-prompt-status", trace.completed ? "run complete" : "processing runtime");

  const modelEvent = trace.events.find((event) => event.node === "model" && event.metadata?.provider);
  setText("safe-model-label", modelEvent?.metadata?.provider || "mindpal-runtime");

  renderGraph();
  renderActivity();
  renderTerminal();
  renderTelemetry();
}

function showLocalStage(event) {
  if (trace || paused) return;
  setText("safe-status", "RUNNING");
  setText("safe-top-status", "RUNNING");
  setText("safe-prompt-status", `${String(event.stage || "runtime").toLowerCase()}…`);
}

function renderGraph() {
  const svg = document.getElementById("safe-graph-svg");
  if (!svg || !trace) return;

  const latest = new Map();
  const parents = new Map();

  trace.events.forEach((event) => {
    latest.set(event.node, event);
    if (event.parent) parents.set(event.node, event.parent);
  });

  const nodes = [...latest.keys()]
    .filter((node) => POSITIONS[node])
    .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));

  const edges = nodes
    .map((node) => [parents.get(node), node])
    .filter(([from, to]) => from && nodes.includes(from) && POSITIONS[from] && POSITIONS[to]);

  svg.innerHTML = `
    ${edges.map(([from, to]) => edgeMarkup(from, to, latest.get(to))).join("")}
    ${nodes.map((node) => nodeMarkup(node, latest.get(node))).join("")}
  `;

  svg.querySelectorAll(".safe-node").forEach((el) => {
    el.addEventListener("click", () => {
      selectedNode = el.dataset.node;
      renderNodeInfo();
      svg.querySelectorAll(".safe-node").forEach((item) => {
        item.classList.toggle("selected", item === el);
      });
    });
  });

  renderNodeInfo();
}

function edgeMarkup(from, to, event) {
  const [x1, y1] = POSITIONS[from];
  const [x2, y2] = POSITIONS[to];
  const middle = (x1 + x2) / 2;
  const state = event.status === "active" ? "active" : event.status === "failed" ? "weak" : "";
  return `<path class="safe-edge ${state}" d="M ${x1 + 8} ${y1} C ${middle} ${y1},${middle} ${y2},${x2 - 8} ${y2}"/>`;
}

function nodeMarkup(node, event) {
  const [x, y] = POSITIONS[node];
  const state =
    event.status === "failed"
      ? "failed"
      : event.status === "active"
      ? "active"
      : event.status === "completed"
      ? "completed"
      : "inactive";
  const label = node.replaceAll("_", " ").toUpperCase();
  return `<g class="safe-node ${state}" data-node="${node}" tabindex="0" role="button" aria-label="Inspect ${label}">
    <line class="stem" x1="${x}" y1="${y - 34}" x2="${x}" y2="${y + 34}"/>
    <circle class="dot" cx="${x}" cy="${y}" r="6"/>
    <text x="${x}" y="${y - 43}" text-anchor="middle">${label}</text>
  </g>`;
}

function renderNodeInfo() {
  const target = document.getElementById("safe-node-info");
  if (!target) return;

  if (!trace || !selectedNode) {
    target.innerHTML = `
      <h2>NODE INFO</h2>
      <p class="safe-placeholder">Select a node on the runtime graph above to view node details.</p>
    `;
    return;
  }

  const event = [...trace.events].reverse().find((item) => item.node === selectedNode);
  if (!event) return;

  const details = [
    ["Node", selectedNode],
    ["Status", event.status],
    ["Duration", event.duration_ms ? `${event.duration_ms} ms` : "—"],
    ["Parent", event.parent || "—"],
    ...Object.entries(event.metadata || {})
      .slice(0, 5)
      .map(([key, value]) => [key.replaceAll("_", " "), String(value)]),
  ];

  target.innerHTML = `
    <h2>NODE INFO</h2>
    <dl>
      ${details
        .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
        .join("")}
    </dl>
  `;
}

function renderActivity() {
  const target = document.getElementById("safe-activity-lines");
  if (!target || !trace) return;
  target.innerHTML = trace.events
    .slice(-6)
    .map((event) => logLine(event))
    .join("");
}

function renderTerminal() {
  const target = document.getElementById("safe-terminal-lines");
  if (!target || !trace) return;
  target.innerHTML = trace.events
    .slice(-10)
    .map((event) => logLine(event))
    .join("");
  target.scrollTop = target.scrollHeight;
}

function renderTelemetry() {
  if (!trace) return;
  const events = trace.events;
  const memory = events.filter((event) => event.node === "memory" && event.status === "completed").at(-1);
  const tools = events.filter((event) => ["web", "time", "memory_search"].includes(event.node));

  setText("safe-memory", memory ? "ACTIVE" : "OFF");
  setText("safe-tools", tools.length ? String(new Set(tools.map((event) => event.node)).size) : "0");
  setText("safe-node-count", String(new Set(events.map((event) => event.node)).size));
  setText(
    "safe-breadcrumb",
    [...new Set(events.filter((event) => event.status !== "active").map((event) => event.node.replaceAll("_", " ")))]
      .join(" → ") || "Input → Runtime → Output"
  );
}

function logLine(event) {
  const ms = event.timestamp_ms || 0;
  const time = `${Math.floor(ms / 60000)
    .toString()
    .padStart(2, "0")}:${Math.floor((ms % 60000) / 1000)
    .toString()
    .padStart(2, "0")}:${Math.floor(ms % 1000)
    .toString()
    .padStart(3, "0")}`;

  const detail = Object.entries(event.metadata || {})
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");

  return `<div class="safe-log-line">
    <time>${time}</time>
    <span><b>${escapeHtml(event.kind)}</b> ${escapeHtml(event.node.replaceAll("_", " "))}${
    detail ? ` · ${escapeHtml(detail)}` : ""
  }</span>
  </div>`;
}

function updateUptime() {
  const seconds = Math.floor((performance.now() - startAt) / 1000);
  setText(
    "safe-uptime",
    [seconds / 3600, seconds / 60, seconds]
      .map((value, index) => Math.floor(value % (index ? 60 : 24)).toString().padStart(2, "0"))
      .join(":")
  );
}

function runDemoTrace() {
  if (demoTimer) clearTimeout(demoTimer);

  const demoRunId = `demo-${Math.random().toString(36).substring(2, 9)}`;
  const demoPipeline = [
    { sequence: 1, node: "input", parent: null, kind: "ingest", metadata: { source: "user_message", chars: 48 } },
    { sequence: 2, node: "session", parent: "input", kind: "state", metadata: { session_id: "s-1029", active: true } },
    { sequence: 3, node: "guardrails", parent: "session", kind: "safety", metadata: { policy: "strict", safe: true } },
    { sequence: 4, node: "context", parent: "guardrails", kind: "build", metadata: { pack: "standard", tokens: 184 } },
    { sequence: 5, node: "memory", parent: "context", kind: "retrieve", metadata: { memory_v3: "enabled", atoms: 6 } },
    { sequence: 6, node: "tool_router", parent: "memory", kind: "route", metadata: { tool_count: 1, selected: "time" } },
    { sequence: 7, node: "time", parent: "tool_router", kind: "tool_exec", metadata: { timezone: "UTC", ok: true } },
    { sequence: 8, node: "model", parent: "time", kind: "llm_call", metadata: { provider: "gemini-2.5-flash", temp: 0.2 } },
    { sequence: 9, node: "evaluator", parent: "model", kind: "eval", metadata: { score: 0.98, check: "pass" } },
    { sequence: 10, node: "synthesis", parent: "evaluator", kind: "synthesize", metadata: { format: "markdown" } },
    { sequence: 11, node: "output", parent: "synthesis", kind: "stream", metadata: { status: "complete", latency_ms: 320 } },
  ];

  let currentStep = 0;
  const activeEvents = [];

  function step() {
    if (currentStep >= demoPipeline.length) {
      applyTrace({
        run_id: demoRunId,
        completed: true,
        total_duration_ms: 380,
        events: activeEvents.map((e) => ({ ...e, status: "completed", duration_ms: 35 })),
        metrics: { total_nodes: demoPipeline.length },
      });
      return;
    }

    const item = demoPipeline[currentStep];
    const now = Date.now();

    activeEvents.forEach((ev) => {
      ev.status = "completed";
      ev.duration_ms = ev.duration_ms || 32;
    });

    activeEvents.push({
      run_id: demoRunId,
      sequence: item.sequence,
      timestamp_ms: now % 1000000,
      kind: item.kind,
      node: item.node,
      status: "active",
      parent: item.parent,
      metadata: item.metadata,
    });

    applyTrace({
      run_id: demoRunId,
      completed: false,
      total_duration_ms: (currentStep + 1) * 35,
      events: [...activeEvents],
      metrics: { step: currentStep + 1 },
    });

    currentStep++;
    demoTimer = setTimeout(step, 250);
  }

  step();
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>'"]/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;",
      }[char])
  );
}
