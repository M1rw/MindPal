import {
  createBrainEdge,
  loadBrainFocus,
  loadBrainMap,
  loadBrainOverview,
  resolveBrainReview,
  searchBrain,
  updateBrainEdge,
} from "../api.js";

const CATEGORY_META = {
  people: ["People", "#ea7aaf"],
  goals: ["Goals", "#7869f5"],
  projects: ["Goals", "#7869f5"],
  patterns: ["Patterns", "#f2a552"],
  coping_tools: ["Tools", "#3ebfa4"],
  preferences: ["Preferences", "#61a8ff"],
  avoid: ["Boundaries", "#ef7185"],
  relationship_context: ["Context", "#a689f7"],
  profile: ["Context", "#a689f7"],
  facts: ["Reflections", "#7cc4d9"],
};

const VIEW_LABELS = { today: "Today", map: "Map", focus: "Focus", review: "Review" };

let dependencies = {};
let state = {
  open: false,
  view: "today",
  token: null,
  remote: false,
  overview: null,
  map: null,
  selectedId: null,
  focus: null,
  filters: new Set(),
  listMode: false,
  searchTimer: null,
};

export function initBrainWorkspace(nextDependencies = {}) {
  dependencies = nextDependencies;
  bindWorkspaceEvents();
  renderFilters();
}

export async function openBrainWorkspace() {
  const workspace = document.getElementById("brain-workspace");
  const main = document.getElementById("main-content");
  if (!workspace || !main) return;
  state.open = true;
  workspace.hidden = false;
  main.hidden = true;
  document.getElementById("brain-btn")?.setAttribute("aria-pressed", "true");
  await refreshBrainWorkspace({ keepSelection: true });
}

export function closeBrainWorkspace() {
  const workspace = document.getElementById("brain-workspace");
  const main = document.getElementById("main-content");
  if (!workspace || !main) return;
  state.open = false;
  workspace.hidden = true;
  main.hidden = false;
  document.getElementById("brain-btn")?.setAttribute("aria-pressed", "false");
}

export async function refreshBrainWorkspace({ keepSelection = false } = {}) {
  if (!state.open) return;
  setStatus("Refreshing saved memory…");
  const token = await dependencies.getIdToken?.().catch(() => null);
  state.token = token || null;
  state.remote = false;

  try {
    if (token) {
      const categories = [...state.filters];
      const [overview, map] = await Promise.all([
        loadBrainOverview(token),
        loadBrainMap(token, { focusAtomId: state.view === "focus" ? state.selectedId : null, depth: 1, categories }),
      ]);
      state.overview = overview;
      state.map = map;
      state.remote = true;
      setStatus("Cloud memory is up to date.");
    } else {
      hydrateLocalBrain();
      setStatus("Using memory stored on this device.");
    }
  } catch (error) {
    console.warn("Brain cloud refresh failed; showing local graph", error);
    hydrateLocalBrain();
    setStatus("Using local memory while cloud sync is unavailable.");
  }

  if (!keepSelection) state.selectedId = null;
  renderWorkspace();
  if (state.selectedId) await selectBrainNode(state.selectedId, { preserveView: true });
}

function bindWorkspaceEvents() {
  document.getElementById("brain-btn")?.addEventListener("click", () => { void openBrainWorkspace(); });
  document.getElementById("brain-close-btn")?.addEventListener("click", closeBrainWorkspace);
  document.getElementById("brain-refresh-btn")?.addEventListener("click", () => { void refreshBrainWorkspace({ keepSelection: true }); });
  document.getElementById("brain-list-toggle")?.addEventListener("click", () => {
    state.listMode = !state.listMode;
    renderListEquivalent();
  });
  document.querySelectorAll("[data-brain-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.getAttribute("data-brain-view") || "today";
      document.querySelectorAll("[data-brain-view]").forEach((item) => item.classList.toggle("active", item === button));
      renderWorkspace();
    });
  });
  document.getElementById("brain-search-input")?.addEventListener("input", (event) => {
    window.clearTimeout(state.searchTimer);
    const query = String(event.target?.value || "").trim();
    state.searchTimer = window.setTimeout(() => { void runSearch(query); }, 180);
  });
  document.getElementById("brain-main-content")?.addEventListener("click", (event) => {
    const node = event.target.closest?.("[data-brain-node]");
    if (node?.dataset?.brainNode) void selectBrainNode(node.dataset.brainNode);
    const review = event.target.closest?.("[data-brain-review-action]");
    if (review?.dataset?.brainReviewAction) void applyReviewAction(review.dataset.brainReviewAction, review.dataset.brainReviewId);
  });
  document.getElementById("brain-list-equivalent")?.addEventListener("click", (event) => {
    const node = event.target.closest?.("[data-brain-node]");
    if (node?.dataset?.brainNode) void selectBrainNode(node.dataset.brainNode);
  });
  document.getElementById("brain-inspector")?.addEventListener("click", (event) => {
    const action = event.target.closest?.("[data-brain-inspector-action]")?.dataset?.brainInspectorAction;
    if (action === "connect") void connectSelectedNode();
    if (action === "hide-edge") void hideSelectedEdge(event.target.closest("[data-brain-edge]")?.dataset?.brainEdge);
    if (action === "controls") dependencies.openMemoryControls?.();
  });
}

function hydrateLocalBrain() {
  const graph = dependencies.getMemoryGraphContext?.() || { version: 1, atoms: [], brain: {} };
  const atoms = (graph.atoms || []).filter((atom) => atom.status === "active" && atom.sensitivity !== "high" && atom.category !== "safety_context" && !atom.metadata?.brain_hidden);
  const nodes = atoms.map(toLocalNode);
  const ids = new Set(nodes.map((node) => node.id));
  const edges = (graph.brain?.edges || [])
    .filter((edge) => edge.status === "active" && ids.has(edge.source_atom_id) && ids.has(edge.target_atom_id))
    .map(toLocalEdge);
  const pinned = nodes.filter((node) => node.pinned).slice(0, 6);
  const patterns = nodes.filter((node) => node.node_type === "pattern").slice(0, 6);
  const tools = nodes.filter((node) => node.node_type === "coping_tool").slice(0, 6);
  const pending = (graph.brain?.review_queue || []).filter((review) => ["pending", "deferred"].includes(review.status) && ids.has(review.atom_id));
  state.overview = {
    graph_version: Number(graph.version || 1),
    visible_node_count: nodes.length,
    visible_edge_count: edges.length,
    pending_review_count: pending.length,
    pinned_nodes: pinned,
    recent_patterns: patterns,
    suggested_tools: tools,
    stale_node_ids: [],
  };
  state.map = { graph_version: Number(graph.version || 1), scope: state.selectedId ? "local" : "global", nodes: applyFilters(nodes), edges: edges.filter((edge) => applyFilters(nodes).some((node) => node.id === edge.source_atom_id) && applyFilters(nodes).some((node) => node.id === edge.target_atom_id)) };
}

function toLocalNode(atom) {
  const category = atom.category || "facts";
  const nodeType = atom.metadata?.brain_node_type || typeForCategory(category);
  return {
    id: atom.id,
    node_type: nodeType,
    category,
    title: atom.display_value || atom.value || "Untitled memory",
    summary: atom.value || atom.display_value || "",
    confidence: Number(atom.confidence || .6),
    sensitivity: atom.sensitivity || "medium",
    source: atom.source || "manual",
    pinned: Boolean(atom.pinned),
    evidence_count: Number(atom.evidence_count || 0),
    aliases: atom.aliases || [],
    created_at: atom.created_at,
    updated_at: atom.updated_at,
    last_confirmed_at: atom.last_seen_at,
    hidden_from_replies: Boolean(atom.metadata?.brain_hidden_from_replies),
  };
}

function toLocalEdge(edge) {
  return { ...edge, tentative: Number(edge.confidence || 0) < .75 || !edge.last_confirmed_at };
}

function typeForCategory(category) {
  return ({ people: "person", goals: "goal", projects: "goal", patterns: "pattern", coping_tools: "coping_tool", preferences: "preference", avoid: "boundary", facts: "reflection" })[category] || "context";
}

function applyFilters(nodes) {
  return state.filters.size ? nodes.filter((node) => state.filters.has(node.category)) : nodes;
}

function renderFilters() {
  const target = document.getElementById("brain-category-filters");
  if (!target) return;
  target.replaceChildren();
  const categories = ["goals", "patterns", "people", "coping_tools", "preferences"];
  for (const category of categories) {
    const button = document.createElement("button");
    button.className = `brain-filter-chip${state.filters.has(category) ? " active" : ""}`;
    button.type = "button";
    button.textContent = CATEGORY_META[category]?.[0] || category;
    button.addEventListener("click", () => {
      if (state.filters.has(category)) state.filters.delete(category); else state.filters.add(category);
      renderFilters();
      void refreshBrainWorkspace({ keepSelection: true });
    });
    target.append(button);
  }
}

function renderWorkspace() {
  const overview = state.overview || emptyOverview();
  document.getElementById("brain-version").textContent = `v${overview.graph_version || 1}`;
  document.getElementById("brain-mode-label").textContent = state.remote ? "CLOUD" : "LOCAL";
  document.getElementById("brain-review-count").textContent = String(overview.pending_review_count || 0);
  document.getElementById("brain-today-count").textContent = String(overview.visible_node_count || 0);
  const target = document.getElementById("brain-main-content");
  if (!target) return;
  if (state.view === "map" || state.view === "focus") target.innerHTML = renderMap();
  else if (state.view === "review") target.innerHTML = renderReview();
  else target.innerHTML = renderToday();
  renderListEquivalent();
  dependencies.refreshIcons?.();
}

function renderToday() {
  const overview = state.overview || emptyOverview();
  return `<section class="brain-today">
    <div class="brain-card brain-hero"><div><span class="brain-kicker">${overview.visible_node_count || 0} saved memories · ${overview.visible_edge_count || 0} connections</span><h2>Memory, when it helps.</h2><p>MindPal uses a small, relevant set of your saved context to keep conversations continuous.</p></div></div>
    <div class="brain-today-grid">
      ${renderSignalCard("star", "Saved priorities", overview.pinned_nodes, "Pin the memories you want MindPal to keep easy to find.")}
      ${renderSignalCard("activity", "Patterns to notice", overview.recent_patterns, "Repeated context that may be useful to check in on.")}
      ${renderSignalCard("heart-pulse", "Helpful supports", overview.suggested_tools, "Things you have said help you. These are not treatment recommendations.")}
    </div>
  </section>`;
}

function renderSignalCard(icon, heading, nodes, empty) {
  return `<article class="brain-card brain-signal-card"><header><span><i data-lucide="${icon}" class="w-3.5 h-3.5"></i> ${heading}</span><span>${nodes?.length || 0}</span></header>${nodes?.length ? nodes.map((node) => `<button class="brain-signal-item" type="button" data-brain-node="${escapeAttribute(node.id)}"><i class="brain-node-dot" style="--node-color:${nodeColor(node)}"></i><span>${escapeHtml(node.title)}</span></button>`).join("") : `<p class="brain-empty-copy">${escapeHtml(empty)}</p>`}</article>`;
}

function renderMap() {
  const map = state.map || { nodes: [], edges: [], scope: "global" };
  const nodes = map.nodes || [];
  const positions = layoutNodes(nodes);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = (map.edges || []).filter((edge) => positions.has(edge.source_atom_id) && positions.has(edge.target_atom_id));
  const edgeMarkup = edges.map((edge) => {
    const source = positions.get(edge.source_atom_id); const target = positions.get(edge.target_atom_id);
    const stateClass = `${edge.tentative ? " tentative" : ""}${edge.relation === "contradicts" ? " conflict" : ""}`;
    return `<line class="brain-edge-line${stateClass}" x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}"/>`;
  }).join("");
  const nodeMarkup = nodes.map((node) => {
    const point = positions.get(node.id); const color = nodeColor(node); const label = trimLabel(node.title, 20);
    return `<g class="brain-node-button" role="button" tabindex="0" aria-label="Focus ${escapeAttribute(node.title)}" data-brain-node="${escapeAttribute(node.id)}" style="--node-color:${color}"><circle class="brain-node-ring" cx="${point.x}" cy="${point.y}" r="21"></circle><circle class="brain-node-core" cx="${point.x}" cy="${point.y}" r="7"></circle><text class="brain-node-label" x="${point.x}" y="${point.y + 34}" text-anchor="middle">${escapeHtml(label)}</text></g>`;
  }).join("");
  const legend = [...new Set(nodes.map((node) => node.category))].slice(0, 6).map((category) => `<span><i class="brain-node-dot" style="--node-color:${nodeColor({ category })}"></i>${escapeHtml(CATEGORY_META[category]?.[0] || category)}</span>`).join("");
  return `<section class="brain-map"><header class="brain-map-head"><div><h2>${state.view === "focus" ? "Focused memories" : "Connections"}</h2><p>See how saved memories relate. Sensitive memories remain private in this view.</p></div><span class="brain-map-scope">${escapeHtml((map.scope || "all").toUpperCase())} · ${nodes.length} MEMORIES</span></header><div class="brain-map-stage">${nodes.length ? `<svg class="brain-map-svg" viewBox="0 0 800 480" role="img" aria-label="Interactive Brain relationship map">${edgeMarkup}${nodeMarkup}</svg>` : `<div class="brain-inspector-empty"><i data-lucide="orbit" class="w-7 h-7"></i><p>Saved memories will appear here as you choose what MindPal keeps.</p></div>`}</div><div class="brain-map-legend">${legend || "No visible categories"}</div></section>`;
}

function renderReview() {
  const graph = dependencies.getMemoryGraphContext?.() || {};
  const atomById = new Map((graph.atoms || []).map((atom) => [atom.id, toLocalNode(atom)]));
  const reviews = (graph.brain?.review_queue || []).filter((item) => ["pending", "deferred"].includes(item.status));
      return `<section class="brain-review"><header class="brain-review-head"><h2>Review memories</h2><p>Confirm, correct, defer, pin, or forget what MindPal retains. You remain in control.</p></header><div class="brain-review-list">${reviews.length ? reviews.map((review) => { const node = atomById.get(review.atom_id); return `<article class="brain-card brain-review-card"><header><span class="brain-review-kind">${escapeHtml(review.kind)} · needs attention</span><span class="brain-confidence">${escapeHtml(review.status)}</span></header><h3>${escapeHtml(node?.title || "Unavailable memory")}</h3><p>${escapeHtml(review.reason || "Check whether this is still useful and accurate.")}</p><div class="brain-review-actions"><button type="button" data-brain-review-id="${escapeAttribute(review.id)}" data-brain-review-action="confirm">Confirm</button><button type="button" data-brain-review-id="${escapeAttribute(review.id)}" data-brain-review-action="defer">Defer</button><button type="button" data-brain-review-id="${escapeAttribute(review.id)}" data-brain-review-action="pin">Pin</button><button type="button" data-brain-review-id="${escapeAttribute(review.id)}" data-brain-review-action="forget">Forget</button></div></article>`; }).join("") : `<article class="brain-card brain-review-card"><h3>You are all caught up</h3><p>There are no memories waiting for review. MindPal will surface stale or conflicting items here instead of silently guessing.</p></article>`}</div></section>`;
}

function renderListEquivalent() {
  const list = document.getElementById("brain-list-equivalent");
  const main = document.getElementById("brain-main-content");
  const toggle = document.getElementById("brain-list-toggle");
  if (!list || !main) return;
  list.hidden = !state.listMode;
  main.hidden = state.listMode;
  if (toggle) toggle.innerHTML = state.listMode ? '<i data-lucide="network" class="w-4 h-4"></i><span>Map</span>' : '<i data-lucide="list-tree" class="w-4 h-4"></i><span>List</span>';
  if (!state.listMode) return;
  const nodes = state.map?.nodes || [];
  list.innerHTML = `<table><thead><tr><th>Signal</th><th>Type</th><th>Confidence</th><th>Updated</th></tr></thead><tbody>${nodes.map((node) => `<tr><td><button type="button" data-brain-node="${escapeAttribute(node.id)}">${escapeHtml(node.title)}</button></td><td>${escapeHtml(node.node_type)}</td><td>${Math.round(Number(node.confidence || 0) * 100)}%</td><td>${formatDate(node.updated_at)}</td></tr>`).join("") || "<tr><td colspan=\"4\">No visible Brain signals.</td></tr>"}</tbody></table>`;
  dependencies.refreshIcons?.();
}

async function selectBrainNode(atomId, { preserveView = false } = {}) {
  if (!atomId) return;
  state.selectedId = atomId;
  if (!preserveView) state.view = "focus";
  try {
    if (state.remote && state.token) state.focus = await loadBrainFocus(atomId, state.token);
    else state.focus = localFocus(atomId);
  } catch (error) {
    console.warn("Brain focus query failed", error);
    state.focus = localFocus(atomId);
  }
  if (state.view === "focus") {
    if (state.focus?.local_map) state.map = state.focus.local_map;
    else if (state.focus?.map) state.map = state.focus.map;
  }
  document.querySelectorAll("[data-brain-view]").forEach((button) => button.classList.toggle("active", button.getAttribute("data-brain-view") === state.view));
  renderWorkspace();
  renderInspector();
}

function localFocus(atomId) {
  const graph = dependencies.getMemoryGraphContext?.() || {};
  const node = (state.map?.nodes || []).find((item) => item.id === atomId) || toLocalNode((graph.atoms || []).find((item) => item.id === atomId) || {});
  const visibleIds = new Set((state.map?.nodes || []).map((item) => item.id));
  const backlinks = (graph.brain?.edges || []).filter((edge) => edge.status === "active" && (edge.source_atom_id === atomId || edge.target_atom_id === atomId) && visibleIds.has(edge.source_atom_id) && visibleIds.has(edge.target_atom_id)).map(toLocalEdge);
  const evidence = (graph.brain?.evidence || []).filter((item) => item.atom_id === atomId && item.sensitivity !== "high");
  const relatedIds = new Set([atomId]); backlinks.forEach((edge) => { relatedIds.add(edge.source_atom_id); relatedIds.add(edge.target_atom_id); });
  const localNodes = (state.map?.nodes || []).filter((item) => relatedIds.has(item.id));
  return { node, evidence, backlinks, local_map: { graph_version: state.overview?.graph_version || 1, scope: "local", nodes: localNodes, edges: backlinks } };
}

function renderInspector() {
  const target = document.getElementById("brain-inspector");
  const focus = state.focus;
  if (!target || !focus?.node?.id) return;
  const node = focus.node;
  target.innerHTML = `<div class="brain-inspector-head"><div><span class="brain-inspector-eyebrow">${escapeHtml(node.node_type)}</span><h2 class="brain-inspector-title">${escapeHtml(node.title)}</h2></div><span class="brain-confidence">${Math.round(Number(node.confidence || 0) * 100)}% certain</span></div><p class="brain-inspector-summary">${escapeHtml(node.summary || "No additional summary.")}</p><div class="brain-property-grid"><div class="brain-property"><span>Source</span><b>${escapeHtml(node.source || "memory")}</b></div><div class="brain-property"><span>Last seen</span><b>${formatDate(node.last_confirmed_at || node.updated_at)}</b></div><div class="brain-property"><span>Evidence</span><b>${Number(node.evidence_count || focus.evidence?.length || 0)} records</b></div><div class="brain-property"><span>Use in replies</span><b>${node.hidden_from_replies ? "Off" : "On"}</b></div></div><section class="brain-inspector-section"><h3><i data-lucide="quote" class="w-3.5 h-3.5"></i> Evidence</h3>${focus.evidence?.length ? focus.evidence.map((item) => `<div class="brain-evidence">“${escapeHtml(item.excerpt)}”<small>${escapeHtml(item.source || "memory")} · ${formatDate(item.captured_at)}</small></div>`).join("") : '<p class="brain-empty-copy">No separate excerpt is attached. The saved item retains its source and confidence.</p>'}</section><section class="brain-inspector-section"><h3><i data-lucide="git-branch" class="w-3.5 h-3.5"></i> Backlinks</h3>${focus.backlinks?.length ? focus.backlinks.map((edge) => `<div class="brain-backlink" data-brain-edge="${escapeAttribute(edge.id)}"><b>${escapeHtml(edge.relation.replaceAll("_", " "))}</b><small>${Math.round(Number(edge.confidence || 0) * 100)}% confidence${edge.tentative ? " · tentative" : ""}</small></div>`).join("") : '<p class="brain-empty-copy">No visible links yet. You can create a deliberate connection below.</p>'}</section><div class="brain-action-row"><button class="brain-action" type="button" data-brain-inspector-action="connect">Connect signal</button><button class="brain-action" type="button" data-brain-inspector-action="controls">Memory controls</button></div>`;
  dependencies.refreshIcons?.();
}

async function runSearch(query) {
  if (!query) { void refreshBrainWorkspace({ keepSelection: true }); return; }
  try {
    const nodes = state.remote && state.token ? await searchBrain(query, state.token, { categories: [...state.filters] }) : applyFilters(state.map?.nodes || []).filter((node) => `${node.title} ${node.summary} ${(node.aliases || []).join(" ")}`.toLowerCase().includes(query.toLowerCase()));
    state.view = "map";
    state.map = { graph_version: state.overview?.graph_version || 1, scope: "search", nodes, edges: (state.map?.edges || []).filter((edge) => nodes.some((node) => node.id === edge.source_atom_id) && nodes.some((node) => node.id === edge.target_atom_id)) };
    document.querySelectorAll("[data-brain-view]").forEach((button) => button.classList.toggle("active", button.getAttribute("data-brain-view") === "map"));
    setStatus(`${nodes.length} matching memories`);
    renderWorkspace();
  } catch (error) {
    dependencies.showToast?.("Memory search is temporarily unavailable.");
  }
}

async function connectSelectedNode() {
  const source = state.selectedId;
  const candidates = (state.map?.nodes || []).filter((node) => node.id !== source);
  if (!source || !candidates.length) { dependencies.showToast?.("Add another visible memory before linking signals."); return; }
  const choices = candidates.slice(0, 12).map((node) => `${node.id} — ${node.title}`).join("\n");
  const answer = window.prompt(`Connect this signal to an atom ID:\n${choices}`, candidates[0].id);
  const target = String(answer || "").trim();
  if (!target || !candidates.some((node) => node.id === target)) return;
  const relation = window.prompt("Relationship type: relates_to, affects, helps_with, blocks, part_of, contradicts, or supersedes", "relates_to") || "relates_to";
  if (!["relates_to", "affects", "helps_with", "blocks", "part_of", "contradicts", "supersedes"].includes(relation)) { dependencies.showToast?.("Choose a supported Brain relationship type."); return; }
  try {
    if (state.remote && state.token) await createBrainEdge({ source_atom_id: source, target_atom_id: target, relation, expected_version: state.overview?.graph_version }, state.token);
    else mutateLocalBrain((graph) => ({ ...graph, brain: { ...graph.brain, edges: [...(graph.brain?.edges || []), { id: `edge_${crypto.randomUUID?.() || Date.now()}`, source_atom_id: source, target_atom_id: target, relation, confidence: .9, status: "active", source: "manual", evidence_ids: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_confirmed_at: new Date().toISOString() }] } }));
    dependencies.showToast?.("Brain link created.");
    await refreshBrainWorkspace({ keepSelection: true });
  } catch (error) { dependencies.showToast?.("Could not create this Brain link."); }
}

async function hideSelectedEdge(edgeId) {
  if (!edgeId) return;
  try {
    if (state.remote && state.token) await updateBrainEdge(edgeId, "hide", state.token, state.overview?.graph_version);
    else mutateLocalBrain((graph) => ({ ...graph, brain: { ...graph.brain, edges: (graph.brain?.edges || []).map((edge) => edge.id === edgeId ? { ...edge, status: "hidden", updated_at: new Date().toISOString() } : edge) } }));
    await refreshBrainWorkspace({ keepSelection: true });
  } catch { dependencies.showToast?.("Could not update this Brain link."); }
}

async function applyReviewAction(action, reviewId) {
  if (!reviewId || !action) return;
  try {
    if (state.remote && state.token) await resolveBrainReview(reviewId, action, state.token, state.overview?.graph_version);
    else mutateLocalBrain((graph) => {
      const review = (graph.brain?.review_queue || []).find((item) => item.id === reviewId);
      const now = new Date().toISOString();
      const status = action === "defer" ? "deferred" : action === "confirm" || action === "pin" ? "confirmed" : "dismissed";
      return { ...graph, atoms: (graph.atoms || []).map((atom) => atom.id !== review?.atom_id ? atom : { ...atom, pinned: action === "pin" ? true : atom.pinned, status: action === "forget" ? "deleted" : atom.status, updated_at: now, last_seen_at: now }), brain: { ...graph.brain, review_queue: (graph.brain?.review_queue || []).map((item) => item.id === reviewId ? { ...item, status, updated_at: now } : item) } };
    });
    dependencies.showToast?.(action === "forget" ? "Memory removed from Brain." : "Brain review updated.");
    await refreshBrainWorkspace({ keepSelection: true });
  } catch { dependencies.showToast?.("Could not update this review item."); }
}

function mutateLocalBrain(mutator) {
  const graph = dependencies.getMemoryGraphContext?.();
  if (!graph) return;
  const next = mutator(structuredClone(graph));
  dependencies.setMemoryGraphContext?.(next);
  dependencies.persistMemoryContextSafe?.();
}

function layoutNodes(nodes) {
  const positions = new Map();
  const total = Math.max(nodes.length, 1);
  nodes.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / total - Math.PI / 2;
    const radius = total === 1 ? 0 : 112 + (index % 3) * 55;
    positions.set(node.id, { x: 400 + Math.cos(angle) * radius * 1.55, y: 235 + Math.sin(angle) * radius });
  });
  return positions;
}

function nodeColor(node) { return CATEGORY_META[node.category]?.[1] || "#6f67df"; }
function trimLabel(value, limit) { const text = String(value || ""); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; }
function formatDate(value) { const date = new Date(value || 0); return Number.isFinite(date.getTime()) && date.getTime() > 0 ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Not confirmed"; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
function escapeAttribute(value) { return escapeHtml(value).replace(/`/g, "&#96;"); }
function emptyOverview() { return { graph_version: 1, visible_node_count: 0, visible_edge_count: 0, pending_review_count: 0, pinned_nodes: [], recent_patterns: [], suggested_tools: [] }; }
function setStatus(value) { const target = document.getElementById("brain-status-copy"); if (target) target.textContent = value; }
