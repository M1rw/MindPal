// frontend/js/memory_graph.js — Graph-based memory system

import {
  hashString,
  mergeUnique,
  normalizeStringList,
  normalizeName,
  normalizeNameValue,
  isExplicitMemoryCommand,
  formatGenericSavedReply,
  extractPreferredName,
  extractGirlfriendNameAndAliases,
  extractProject,
  extractGraphPreferences,
  extractGraphAvoid,
  normalizeAvoidValue,
} from "./utils/memory_helpers.js";

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

const MEMORY_GRAPH_STORAGE_KEY = "mindpal_memory_graph_v3";

const GRAPH_CATEGORY_LABELS = {
  profile: "Profile",
  people: "People",
  projects: "Projects",
  preferences: "Preferences",
  avoid: "Avoid",
  patterns: "Patterns",
  goals: "Goals",
  relationship_context: "Relationship",
  coping_tools: "Coping Tools",
  safety_context: "Safety",
  facts: "Other Facts",
};

const GRAPH_CATEGORY_ORDER = [
  "profile", "people", "projects", "preferences", "avoid",
  "patterns", "goals", "relationship_context", "coping_tools",
  "safety_context", "facts",
];

// ═══════════════════════════════════════════════════════════════
// CRUD
// ═══════════════════════════════════════════════════════════════

export function createEmptyMemoryGraph() {
  const now = new Date().toISOString();
  return {
    user_id_hash: "client",
    atoms: [],
    version: 1,
    source: "manual",
    full_snapshot: true,
    created_at: now,
    updated_at: now,
  };
}

export function loadMemoryGraphContext() {
  try {
    const raw = localStorage.getItem(MEMORY_GRAPH_STORAGE_KEY);
    if (raw) return normalizeMemoryGraph(JSON.parse(raw));

    // Lazy import avoided: caller passes legacy memory if needed
    return createEmptyMemoryGraph();
  } catch {
    return createEmptyMemoryGraph();
  }
}

export function saveMemoryGraphContext(graph) {
  const normalized = normalizeMemoryGraph(graph);
  normalized.updated_at = new Date().toISOString();

  try {
    localStorage.setItem(MEMORY_GRAPH_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Ignore browser storage failures.
  }

  return normalized;
}

// ═══════════════════════════════════════════════════════════════
// Normalization
// ═══════════════════════════════════════════════════════════════

export function normalizeMemoryGraph(value) {
  const base = createEmptyMemoryGraph();
  const raw = value && typeof value === "object" ? value : {};
  const atoms = Array.isArray(raw.atoms) ? raw.atoms.map(normalizeMemoryAtom).filter(Boolean) : [];
  const seen = new Set();
  const deduped = [];

  for (const atom of atoms) {
    if (seen.has(atom.id)) continue;
    seen.add(atom.id);
    deduped.push(atom);
  }

  return {
    ...base,
    ...raw,
    user_id_hash: String(raw.user_id_hash || raw.userIdHash || "client"),
    atoms: deduped.slice(0, 500),
    version: Math.max(1, Number(raw.version || 1)),
    source: String(raw.source || "manual"),
    full_snapshot: raw.full_snapshot !== false && raw.fullSnapshot !== false,
    created_at: raw.created_at || raw.createdAt || base.created_at,
    updated_at: raw.updated_at || raw.updatedAt || base.updated_at,
  };
}

function normalizeMemoryAtom(value) {
  if (!value || typeof value !== "object") return null;

  const category = normalizeGraphCategory(value.category);
  const rawValue = String(value.value || value.display_value || value.displayValue || "").trim();
  if (!rawValue) return null;

  const metadata = value.metadata && typeof value.metadata === "object" ? value.metadata : {};
  const key = String(value.key || canonicalGraphKey(category, rawValue, metadata));
  const id = String(value.id || `mem_${hashString(`${category}|${key}`)}`);
  const now = new Date().toISOString();

  return {
    id,
    category,
    key,
    value: rawValue,
    normalized_value: normalizeGraphValue(value.normalized_value || value.normalizedValue || rawValue),
    display_value: String(value.display_value || value.displayValue || rawValue).trim(),
    confidence: clampNumber(value.confidence, 0, 1, 0.6),
    sensitivity: ["low", "medium", "high"].includes(value.sensitivity) ? value.sensitivity : "medium",
    source: normalizeGraphSource(value.source),
    status: ["active", "archived", "deleted"].includes(value.status) ? value.status : "active",
    pinned: Boolean(value.pinned),
    created_at: value.created_at || value.createdAt || now,
    updated_at: value.updated_at || value.updatedAt || now,
    last_seen_at: value.last_seen_at || value.lastSeenAt || value.updated_at || now,
    evidence_count: Math.max(0, Number(value.evidence_count || value.evidenceCount || 1)),
    aliases: normalizeStringList(value.aliases || []),
    metadata,
  };
}

function createMemoryAtom(category, value, options = {}) {
  const normalizedCategory = normalizeGraphCategory(category);
  const metadata = options.metadata || {};
  const key = canonicalGraphKey(normalizedCategory, value, metadata);
  const id = `mem_${hashString(`${normalizedCategory}|${key}`)}`;
  const now = new Date().toISOString();

  return normalizeMemoryAtom({
    id,
    category: normalizedCategory,
    key,
    value,
    normalized_value: normalizeGraphValue(value),
    display_value: options.displayValue || value,
    confidence: options.confidence ?? 0.6,
    sensitivity: options.sensitivity || "medium",
    source: options.source || "chat_extraction",
    status: options.status || "active",
    pinned: Boolean(options.pinned),
    created_at: now,
    updated_at: now,
    last_seen_at: now,
    evidence_count: 1,
    aliases: options.aliases || [],
    metadata,
  });
}

// ═══════════════════════════════════════════════════════════════
// Merge
// ═══════════════════════════════════════════════════════════════

export function mergeMemoryGraphs(existingGraph, incomingGraphOrAtoms) {
  const existing = normalizeMemoryGraph(existingGraph);
  const incomingAtoms = Array.isArray(incomingGraphOrAtoms)
    ? incomingGraphOrAtoms.map(normalizeMemoryAtom).filter(Boolean)
    : normalizeMemoryGraph(incomingGraphOrAtoms).atoms;
  let next = normalizeMemoryGraph(existing);

  for (const atom of incomingAtoms) {
    next = upsertMemoryGraphAtom(next, atom);
  }

  if (incomingAtoms.length) {
    next.version = Math.max(existing.version + 1, Number(incomingGraphOrAtoms?.version || 1));
    next.updated_at = new Date().toISOString();
  }

  return normalizeMemoryGraph(next);
}

function upsertMemoryGraphAtom(graph, atom) {
  const next = normalizeMemoryGraph(graph);
  const incoming = normalizeMemoryAtom(atom);
  if (!incoming) return next;

  const tombstone = next.atoms.find((item) => (
    item.status === "deleted" &&
    item.category === incoming.category &&
    (item.key === incoming.key || item.normalized_value === incoming.normalized_value)
  ));

  if (tombstone && incoming.source !== "manual") return next;

  const index = findMatchingGraphAtomIndex(next.atoms, incoming);
  if (index < 0) {
    next.atoms.push(incoming);
    return next;
  }

  const current = next.atoms[index];
  if (current.status === "deleted" && incoming.source !== "manual") return next;

  const displayWinner = incomingDisplayWins(current, incoming) ? incoming : current;
  const cap = incoming.source === "manual" || incoming.pinned ? 1 : 0.98;

  next.atoms[index] = {
    ...current,
    value: displayWinner.value,
    display_value: displayWinner.display_value,
    normalized_value: displayWinner.normalized_value,
    confidence: Math.min(cap, Math.max(current.confidence, incoming.confidence) + 0.04),
    sensitivity: maxSensitivity(current.sensitivity, incoming.sensitivity),
    source: strongerSource(current.source, incoming.source),
    status: incoming.status === "deleted" ? "deleted" : current.status,
    pinned: current.pinned || incoming.pinned,
    updated_at: maxIso(current.updated_at, incoming.updated_at),
    last_seen_at: maxIso(current.last_seen_at, incoming.last_seen_at),
    evidence_count: Math.min(10000, Number(current.evidence_count || 0) + Math.max(1, Number(incoming.evidence_count || 1))),
    aliases: mergeUnique([...(current.aliases || []), ...(incoming.aliases || [])]),
    metadata: { ...(current.metadata || {}), ...(incoming.metadata || {}) },
  };

  return next;
}

function findMatchingGraphAtomIndex(atoms, incoming) {
  const incomingAliases = new Set((incoming.aliases || []).map(normalizeGraphValue));

  return atoms.findIndex((atom) => {
    if (atom.category !== incoming.category) return false;
    if (atom.key === incoming.key) return true;
    if (atom.normalized_value === incoming.normalized_value) return true;
    if (atom.category === "people") {
      const aliases = new Set((atom.aliases || []).map(normalizeGraphValue));
      if ([...incomingAliases].some((alias) => aliases.has(alias))) return true;
      return atom.metadata?.relationship && atom.metadata.relationship === incoming.metadata?.relationship;
    }
    return false;
  });
}

// ═══════════════════════════════════════════════════════════════
// Backend conversion
// ═══════════════════════════════════════════════════════════════

export function memoryGraphFromBackend(payload) {
  const graph = payload?.graph || payload?.memory_graph_snapshot || payload?.memory_graph_delta || payload;
  return normalizeMemoryGraph(graph);
}

export function memoryGraphToBackend(graph) {
  return normalizeMemoryGraph(graph);
}

export function memoryGraphFromLegacyMemory(legacyMemory) {
  const graph = createEmptyMemoryGraph();

  if (!legacyMemory) return graph;

  if (legacyMemory.preferredName) {
    graph.atoms.push(createMemoryAtom("profile", legacyMemory.preferredName, {
      displayValue: `Preferred name: ${legacyMemory.preferredName}`,
      confidence: 0.9,
      source: "manual",
      metadata: { field: "preferred_name" },
    }));
  }

  for (const person of legacyMemory.importantPeople || []) {
    const aliases = [person.canonicalName, ...(person.aliases || [])].filter(Boolean);
    graph.atoms.push(createMemoryAtom("people", person.canonicalName, {
      displayValue: `${mergeUnique(aliases).join(" / ")}${person.relationship ? ` - ${person.relationship}` : ""}`,
      confidence: person.confidence || 0.8,
      source: "manual",
      aliases,
      metadata: { relationship: person.relationship || "" },
    }));
  }

  for (const fact of legacyMemory.relationshipFacts || []) {
    graph.atoms.push(createMemoryAtom("relationship_context", fact.summary, {
      confidence: fact.confidence || 0.65,
      source: "chat_extraction",
      aliases: fact.people || [],
    }));
  }

  for (const value of legacyMemory.communicationPreferences?.responseStyle || []) {
    graph.atoms.push(createMemoryAtom("preferences", value, { confidence: 0.78, source: "manual" }));
  }
  if (legacyMemory.communicationPreferences?.tone) {
    graph.atoms.push(createMemoryAtom("preferences", `${legacyMemory.communicationPreferences.tone} tone`, { confidence: 0.78, source: "manual" }));
  }
  if (legacyMemory.communicationPreferences?.language) {
    graph.atoms.push(createMemoryAtom("preferences", legacyMemory.communicationPreferences.language, { confidence: 0.82, source: "manual" }));
  }

  for (const value of mergeUnique([...(legacyMemory.communicationPreferences?.avoid || []), ...(legacyMemory.avoidedResponses || [])])) {
    graph.atoms.push(createMemoryAtom("avoid", value, { confidence: 0.9, source: "manual" }));
  }

  for (const value of legacyMemory.emotionalTriggers || []) {
    graph.atoms.push(createMemoryAtom("patterns", value, { confidence: 0.65, source: "chat_extraction" }));
  }

  for (const value of legacyMemory.userGoals || []) {
    graph.atoms.push(createMemoryAtom("goals", value, { confidence: 0.7, source: "chat_extraction" }));
  }

  return normalizeMemoryGraph(graph);
}

// ═══════════════════════════════════════════════════════════════
// Query
// ═══════════════════════════════════════════════════════════════

export function buildMemoryGraphLines(graphContext = createEmptyMemoryGraph()) {
  const graph = normalizeMemoryGraph(graphContext);
  const cards = getMemoryInspectorCards(graph);
  const lines = [];

  for (const card of cards) {
    if (!card.items.length) continue;
    lines.push(`${card.label}: ${card.items.map((item) => item.value).join(", ")}.`);
  }

  return lines;
}

export function answerQuestionFromMemoryGraph(text, graphContext = createEmptyMemoryGraph()) {
  const lowered = String(text || "").toLowerCase();
  if (!/\b(remember|know about me|my name|what do you know)\b/.test(lowered)) return null;

  const lines = buildMemoryGraphLines(graphContext);
  if (!lines.length) return "I do not have saved memory about that yet.";

  return `Here is what I remember:\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

export function getMemoryInspectorCards(graphContext = createEmptyMemoryGraph()) {
  const graph = normalizeMemoryGraph(graphContext);
  const grouped = new Map();

  for (const category of GRAPH_CATEGORY_ORDER) {
    grouped.set(category, {
      key: category,
      label: GRAPH_CATEGORY_LABELS[category],
      items: [],
    });
  }

  for (const atom of graph.atoms) {
    if (atom.status !== "active") continue;
    const category = grouped.get(atom.category) || grouped.get("facts");
    category.items.push({
      id: atom.id,
      key: atom.key,
      value: atom.display_value || atom.value,
      rawValue: atom.value,
      confidence: atom.confidence,
      source: atom.source,
      pinned: atom.pinned,
      category: atom.category,
    });
  }

  return [...grouped.values()]
    .map((card) => ({
      ...card,
      items: card.items.sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.confidence - left.confidence || left.value.localeCompare(right.value)),
    }))
    .filter((card) => card.items.length);
}

// ═══════════════════════════════════════════════════════════════
// Classify
// ═══════════════════════════════════════════════════════════════

export function classifyAndStoreMemoryGraphFromMessage(text, {
  graphContext = createEmptyMemoryGraph(),
} = {}) {
  const graph = normalizeMemoryGraph(graphContext);
  const message = String(text || "").trim();
  const explicit = isExplicitMemoryCommand(message.toLowerCase());
  const source = explicit ? "manual" : "chat_extraction";
  const confidence = explicit ? 0.95 : 0.68;
  let delta = createEmptyMemoryGraph();
  delta.full_snapshot = false;
  const saved = [];

  const cleanMessage = explicit ? message.replace(/^remember(?: this)?\s*:?\s*/i, "") : message;
  const preferredName = extractPreferredName(cleanMessage);
  if (preferredName) {
    delta.atoms.push(createMemoryAtom("profile", preferredName, {
      displayValue: `Preferred name: ${preferredName}`,
      confidence,
      source,
      pinned: explicit,
      metadata: { field: "preferred_name" },
    }));
    saved.push(`Preferred name saved: ${preferredName}.`);
  }

  const project = extractProject(cleanMessage);
  if (project) {
    delta.atoms.push(createMemoryAtom("projects", project, { confidence, source, pinned: explicit }));
    saved.push(`Project saved: ${project}.`);
  }

  const girlfriendSave = extractGirlfriendNameAndAliases(cleanMessage);
  if (girlfriendSave.name) {
    const aliases = mergeUnique([girlfriendSave.name, ...girlfriendSave.aliases]);
    delta.atoms.push(createMemoryAtom("people", girlfriendSave.name, {
      displayValue: `${aliases.join(" / ")} - girlfriend`,
      confidence: Math.max(confidence, 0.86),
      source,
      pinned: explicit,
      aliases,
      metadata: { relationship: "girlfriend" },
    }));
    saved.push(`Person saved: ${aliases.join(" / ")}.`);
  }

  for (const value of extractGraphPreferences(cleanMessage)) {
    delta.atoms.push(createMemoryAtom("preferences", value, { confidence, source, pinned: explicit }));
    saved.push(`Preference saved: ${value}.`);
  }

  for (const value of extractGraphAvoid(cleanMessage)) {
    delta.atoms.push(createMemoryAtom("avoid", value, { confidence: explicit ? 0.95 : 0.74, source, pinned: explicit }));
    saved.push(`Avoid saved: ${value}.`);
  }

  const merged = mergeMemoryGraphs(graph, delta);
  return {
    graph: saveMemoryGraphContext(merged),
    delta: normalizeMemoryGraph(delta),
    saved,
    confidence: saved.length ? confidence : 0,
    shouldIntercept: explicit && saved.length > 0,
    localReply: saved.length ? formatGenericSavedReply(saved) : "",
  };
}

// ═══════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════

function canonicalGraphKey(category, value, metadata = {}) {
  const role = normalizeGraphValue(metadata.relationship || "");
  const field = normalizeGraphValue(metadata.field || "");
  const basis = [category, field, role, normalizeGraphValue(value)].filter(Boolean).join("|");
  return `${category}:${hashString(basis)}`;
}

function normalizeGraphCategory(category) {
  const value = String(category || "facts");
  return GRAPH_CATEGORY_ORDER.includes(value) ? value : "facts";
}

function normalizeGraphSource(source) {
  const value = String(source || "chat_extraction");
  return ["manual", "chat_extraction", "backend_compaction", "profile", "import"].includes(value) ? value : "chat_extraction";
}

function normalizeGraphValue(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\u0600-\u06ff\s-']+/g, " ")
    .replace(/\b(please|pls|response|responses|answer|answers)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function incomingDisplayWins(current, incoming) {
  if (incoming.source === "manual" && current.source !== "manual") return true;
  if (incoming.pinned && !current.pinned) return true;
  if (incoming.confidence > current.confidence) return true;
  return incoming.updated_at > current.updated_at && incoming.confidence >= current.confidence;
}

function strongerSource(left, right) {
  const rank = { chat_extraction: 1, backend_compaction: 2, import: 3, profile: 4, manual: 5 };
  return (rank[right] || 1) >= (rank[left] || 1) ? right : left;
}

function maxSensitivity(left, right) {
  const rank = { low: 1, medium: 2, high: 3 };
  return (rank[right] || 2) > (rank[left] || 2) ? right : left;
}

function maxIso(left, right) {
  return new Date(right || 0).getTime() > new Date(left || 0).getTime() ? right : left;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

// ═══════════════════════════════════════════════════════════════
// Legacy Bridge Functions
// ═══════════════════════════════════════════════════════════════
// These aliases let code that previously imported from memory_legacy.js
// switch to memory_graph.js without any call-site changes.

/**
 * Legacy alias for createEmptyMemoryGraph().
 * Creates an empty graph (v3 format) instead of the old flat v2 format.
 */
export function createEmptyMemory() {
  return createEmptyMemoryGraph();
}

/**
 * Legacy alias for loadMemoryGraphContext().
 * Loads graph from localStorage, auto-migrating legacy v2 data if present.
 */
export function loadMemoryContext() {
  const graph = loadMemoryGraphContext();
  // Auto-migrate legacy v2 → graph if graph is empty but v2 exists
  if (!graph.atoms || graph.atoms.length === 0) {
    const legacyRaw = localStorage.getItem("mindpal_memory_engine_v2");
    if (legacyRaw) {
      try {
        const legacyData = JSON.parse(legacyRaw);
        if (legacyData && typeof legacyData === "object") {
          const migrated = memoryGraphFromLegacyMemory(legacyData);
          saveMemoryGraphContext(migrated);
          return migrated;
        }
      } catch {
        // Corrupted legacy data — ignore
      }
    }
  }
  return graph;
}

/**
 * Legacy alias for saveMemoryGraphContext(graph).
 */
export function saveMemoryContext(graph) {
  return saveMemoryGraphContext(graph);
}

/**
 * Legacy alias for mergeMemoryGraphs(existing, incoming).
 */
export function mergeMemoryContexts(existing, incoming) {
  return mergeMemoryGraphs(existing, incoming);
}

/**
 * Legacy alias for buildMemoryGraphLines(graph).
 */
export function buildMemoryLines(graph) {
  return buildMemoryGraphLines(graph);
}

/**
 * Convert a backend MemorySummary (flat format) to a MemoryGraph.
 * This replaces the old memoryFromBackendSummary() which returned flat memory.
 * Now it converts the summary to graph atoms on the fly.
 */
export function memoryFromBackendSummary(summary) {
  if (!summary || typeof summary !== "object") return createEmptyMemoryGraph();

  const now = new Date().toISOString();
  const atoms = [];

  // Preferred name
  if (summary.preferred_name) {
    atoms.push(makeAtomFromLegacy("profile", summary.preferred_name,
      `Preferred name: ${summary.preferred_name}`, 0.9, { field: "preferred_name" }));
  }

  // Important people
  for (const person of (summary.important_people || [])) {
    const name = person.canonical_name || "";
    if (!name) continue;
    const aliases = (person.aliases || []).filter(Boolean);
    let label = aliases.length ? aliases.join(" / ") : name;
    if (person.relationship) label += ` - ${person.relationship}`;
    atoms.push(makeAtomFromLegacy("people", name, label,
      person.confidence || 0.7, { relationship: person.relationship || "" }));
  }

  // Relationship facts
  for (const fact of (summary.relationship_facts || [])) {
    if (fact.summary) {
      atoms.push(makeAtomFromLegacy("relationship_context", fact.summary,
        fact.summary, fact.confidence || 0.65));
    }
  }

  // Preferences
  const prefs = summary.communication_preferences || {};
  for (const style of (prefs.response_style || [])) {
    atoms.push(makeAtomFromLegacy("preferences", style, style, 0.78));
  }
  if (prefs.tone) {
    atoms.push(makeAtomFromLegacy("preferences", `${prefs.tone} tone`,
      `${prefs.tone} tone`, 0.78));
  }
  if (prefs.language) {
    atoms.push(makeAtomFromLegacy("preferences", prefs.language,
      prefs.language, 0.82));
  }

  // Avoidances
  const avoidList = [...new Set([...(prefs.avoid || []), ...(summary.avoided_responses || [])])];
  for (const value of avoidList) {
    atoms.push(makeAtomFromLegacy("avoid", value, value, 0.82));
  }

  // Patterns/triggers
  const triggers = [...new Set([...(summary.emotional_triggers || []), ...(summary.known_triggers || [])])];
  for (const value of triggers) {
    atoms.push(makeAtomFromLegacy("patterns", value, value, 0.65));
  }

  // Goals
  const goals = [...new Set([...(summary.user_goals || []), ...(summary.goals || [])])];
  for (const value of goals) {
    atoms.push(makeAtomFromLegacy("goals", value, value, 0.7));
  }

  // Coping tools
  for (const value of (summary.preferred_coping_tools || [])) {
    atoms.push(makeAtomFromLegacy("coping_tools", value, value, 0.7));
  }

  // Safety flags
  for (const value of (summary.safety_flags || [])) {
    atoms.push(makeAtomFromLegacy("safety_context", value, value, 0.7));
  }

  return normalizeMemoryGraph({
    user_id_hash: summary.user_id_hash || "client",
    atoms,
    version: summary.version || 1,
    source: "backend_compaction",
    full_snapshot: true,
    created_at: now,
    updated_at: now,
  });
}

/**
 * Convert a MemoryGraph back to a backend MemorySummary (flat format).
 * Used by cloud sync to write legacy-format summaries.
 */
export function memoryToBackendSummary(graph) {
  if (!graph || !graph.atoms) {
    return { user_id_hash: "client", version: 1 };
  }

  const active = graph.atoms.filter((a) => a.status !== "deleted" && a.status !== "archived");
  const byCategory = {};
  for (const atom of active) {
    (byCategory[atom.category] = byCategory[atom.category] || []).push(atom);
  }

  const preferredNameAtom = (byCategory["profile"] || [])
    .find((a) => a.metadata?.field === "preferred_name");

  return {
    user_id_hash: graph.user_id_hash || "client",
    preferred_name: preferredNameAtom?.value || null,
    important_people: (byCategory["people"] || []).map((a) => ({
      canonical_name: a.value,
      aliases: a.aliases || [a.value],
      relationship: a.metadata?.relationship || "",
      confidence: a.confidence,
      updated_at: a.updated_at,
    })),
    relationship_facts: (byCategory["relationship_context"] || []).map((a) => ({
      summary: a.value,
      people: a.aliases || [],
      confidence: a.confidence,
      updated_at: a.updated_at,
    })),
    communication_preferences: {
      tone: extractToneFromAtoms(byCategory["preferences"] || []),
      language: extractLanguageFromAtoms(byCategory["preferences"] || []),
      response_style: (byCategory["preferences"] || []).map((a) => a.value),
      avoid: (byCategory["avoid"] || []).map((a) => a.value),
    },
    emotional_triggers: (byCategory["patterns"] || []).map((a) => a.value),
    known_triggers: (byCategory["patterns"] || []).map((a) => a.value),
    user_goals: (byCategory["goals"] || []).map((a) => a.value),
    goals: (byCategory["goals"] || []).map((a) => a.value),
    avoided_responses: (byCategory["avoid"] || []).map((a) => a.value),
    preferred_coping_tools: (byCategory["coping_tools"] || []).map((a) => a.value),
    safety_flags: (byCategory["safety_context"] || []).map((a) => a.value),
    preferences: (byCategory["preferences"] || []).map((a) => a.value),
    items: [],
    version: graph.version || 1,
  };
}

/**
 * Legacy alias for answerQuestionFromMemoryGraph().
 */
export function answerQuestionFromMemory(text, context) {
  return answerQuestionFromMemoryGraph(text, context || createEmptyMemoryGraph());
}

/**
 * Legacy alias for classifyAndStoreMemoryGraphFromMessage().
 */
export function classifyAndStoreMemoryFromMessage(text, options = {}) {
  // Map legacy option names to graph option names
  return classifyAndStoreMemoryGraphFromMessage(text, {
    graphContext: options.graphContext || options.memoryContext || createEmptyMemoryGraph(),
    recentMessages: options.recentMessages || [],
    silent: options.silent || false,
  });
}


// ═══════════════════════════════════════════════════════════════
// Internal bridge helpers
// ═══════════════════════════════════════════════════════════════

function makeAtomFromLegacy(category, value, displayValue, confidence, metadata = {}) {
  const normalized = normalizeGraphValue(value);
  const key = `${category}:${hashString(category + "|" + normalized)}`;
  const atomId = `mem_${hashString("client|" + key)}`;
  const now = new Date().toISOString();
  return {
    id: atomId,
    category,
    key,
    value: value || "",
    normalized_value: normalized,
    display_value: displayValue || value || "",
    confidence: clampNumber(confidence, 0, 1, 0.6),
    sensitivity: "medium",
    source: "backend_compaction",
    status: "active",
    pinned: false,
    created_at: now,
    updated_at: now,
    last_seen_at: now,
    evidence_count: 1,
    aliases: [],
    vector: null,
    metadata: metadata || {},
  };
}

function extractToneFromAtoms(atoms) {
  const toneAtom = atoms.find((a) => a.metadata?.field === "tone");
  if (toneAtom) return toneAtom.value;
  const keywords = ["direct", "gentle", "casual", "formal", "warm", "empathetic"];
  for (const atom of atoms) {
    const lower = (atom.normalized_value || atom.value || "").toLowerCase();
    for (const kw of keywords) {
      if (lower.includes(kw)) return kw;
    }
  }
  return "";
}

function extractLanguageFromAtoms(atoms) {
  const langAtom = atoms.find((a) => a.metadata?.field === "language");
  if (langAtom) return langAtom.value;
  const keywords = ["arabic", "english", "french", "spanish", "german", "turkish", "hebrew"];
  for (const atom of atoms) {
    const lower = (atom.normalized_value || atom.value || "").toLowerCase();
    for (const kw of keywords) {
      if (lower.includes(kw)) return atom.value;
    }
  }
  return "";
}
