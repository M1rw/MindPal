// frontend/js/memory_engine.js

const MEMORY_STORAGE_KEY = "mindpal_memory_engine_v2";
const LEGACY_MEMORY_STORAGE_KEY = "mindpal_memory_engine_v1";
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
  "profile",
  "people",
  "projects",
  "preferences",
  "avoid",
  "patterns",
  "goals",
  "relationship_context",
  "coping_tools",
  "safety_context",
  "facts",
];

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

    const legacy = loadMemoryContext();
    return memoryGraphFromLegacyMemory(legacy);
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

export function memoryGraphFromBackend(payload) {
  const graph = payload?.graph || payload?.memory_graph_snapshot || payload?.memory_graph_delta || payload;
  return normalizeMemoryGraph(graph);
}

export function memoryGraphToBackend(graph) {
  return normalizeMemoryGraph(graph);
}

export function memoryGraphFromLegacyMemory(memoryContext = createEmptyMemory()) {
  const memory = normalizeMemory(memoryContext);
  const graph = createEmptyMemoryGraph();

  if (memory.preferredName) {
    graph.atoms.push(createMemoryAtom("profile", memory.preferredName, {
      displayValue: `Preferred name: ${memory.preferredName}`,
      confidence: 0.9,
      source: "manual",
      metadata: { field: "preferred_name" },
    }));
  }

  for (const person of memory.importantPeople) {
    const aliases = [person.canonicalName, ...(person.aliases || [])].filter(Boolean);
    graph.atoms.push(createMemoryAtom("people", person.canonicalName, {
      displayValue: `${mergeUnique(aliases).join(" / ")}${person.relationship ? ` - ${person.relationship}` : ""}`,
      confidence: person.confidence || 0.8,
      source: "manual",
      aliases,
      metadata: { relationship: person.relationship || "" },
    }));
  }

  for (const fact of memory.relationshipFacts) {
    graph.atoms.push(createMemoryAtom("relationship_context", fact.summary, {
      confidence: fact.confidence || 0.65,
      source: "chat_extraction",
      aliases: fact.people || [],
    }));
  }

  for (const value of memory.communicationPreferences.responseStyle || []) {
    graph.atoms.push(createMemoryAtom("preferences", value, { confidence: 0.78, source: "manual" }));
  }
  if (memory.communicationPreferences.tone) {
    graph.atoms.push(createMemoryAtom("preferences", `${memory.communicationPreferences.tone} tone`, { confidence: 0.78, source: "manual" }));
  }
  if (memory.communicationPreferences.language) {
    graph.atoms.push(createMemoryAtom("preferences", memory.communicationPreferences.language, { confidence: 0.82, source: "manual" }));
  }

  for (const value of mergeUnique([...(memory.communicationPreferences.avoid || []), ...(memory.avoidedResponses || [])])) {
    graph.atoms.push(createMemoryAtom("avoid", value, { confidence: 0.9, source: "manual" }));
  }

  for (const value of memory.emotionalTriggers || []) {
    graph.atoms.push(createMemoryAtom("patterns", value, { confidence: 0.65, source: "chat_extraction" }));
  }

  for (const value of memory.userGoals || []) {
    graph.atoms.push(createMemoryAtom("goals", value, { confidence: 0.7, source: "chat_extraction" }));
  }

  return normalizeMemoryGraph(graph);
}

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


export function loadMemoryContext() {
  try {
    const raw = localStorage.getItem(MEMORY_STORAGE_KEY) || localStorage.getItem(LEGACY_MEMORY_STORAGE_KEY);

    if (!raw) {
      return createEmptyMemory();
    }

    return normalizeMemory(JSON.parse(raw));
  } catch {
    return createEmptyMemory();
  }
}

export function saveMemoryContext(memory) {
  const normalized = normalizeMemory(memory);
  normalized.updatedAt = new Date().toISOString();

  try {
    localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Ignore browser storage failures.
  }

  return normalized;
}

export function classifyAndStoreMemoryFromMessage(text, {
  memoryContext = createEmptyMemory(),
  recentMessages = [],
} = {}) {
  const memory = normalizeMemory(memoryContext);
  const message = String(text || "").trim();

  const result = {
    memory,
    saved: [],
    confidence: 0,
    shouldIntercept: false,
    localReply: "",
  };

  if (!message) {
    return result;
  }

  const lower = message.toLowerCase();
  const explicitMemory = isExplicitMemoryCommand(lower);
  const preferredName = extractPreferredName(message);

  if (preferredName) {
    memory.preferredName = preferredName;
    memory.user.preferredName = preferredName;

    upsertFact(memory, {
      key: "profile.preferred_name",
      category: "profile.identity",
      value: `The user's preferred name is ${preferredName}.`,
      confidence: 0.96,
    });

    result.saved.push(`Preferred name saved: ${preferredName}.`);
    result.confidence = Math.max(result.confidence, 0.96);
    result.shouldIntercept = explicitMemory;
  }

  const girlfriendSave = extractGirlfriendNameAndAliases(message);

  if (girlfriendSave.name) {
    memory.relationship.girlfriend.name = girlfriendSave.name;
    memory.relationship.girlfriend.aliases = mergeUnique([
      ...memory.relationship.girlfriend.aliases,
      girlfriendSave.name,
      ...girlfriendSave.aliases,
    ]);
    upsertImportantPerson(memory, {
      canonicalName: girlfriendSave.name,
      aliases: memory.relationship.girlfriend.aliases,
      relationship: "girlfriend",
      confidence: 0.98,
    });

    memory.focus = {
      type: "relationship.girlfriend",
      label: girlfriendSave.name,
      updatedAt: new Date().toISOString(),
    };

    upsertFact(memory, {
      key: "relationship.girlfriend.identity",
      category: "relationship.person",
      value: `The user's girlfriend is called ${girlfriendSave.name}.`,
      confidence: 0.98,
    });

    if (girlfriendSave.aliases.length) {
      upsertFact(memory, {
        key: "relationship.girlfriend.aliases",
        category: "relationship.alias",
        value: `The user may refer to his girlfriend as: ${memory.relationship.girlfriend.aliases.join(", ")}.`,
        confidence: 0.98,
      });
    }

    result.saved.push(`Your girlfriend is called ${girlfriendSave.name}.`);

    for (const alias of girlfriendSave.aliases) {
      result.saved.push(`Alias saved: ${alias}.`);
    }

    result.confidence = 0.98;
    result.shouldIntercept = true;
    result.localReply = formatGirlfriendSavedReply(memory, girlfriendSave);
  }

  const continuationAlias = extractContinuationAlias(message);

  if (
    continuationAlias &&
    !girlfriendSave.name &&
    isLikelyRelationshipContinuation(memory, recentMessages)
  ) {
    const alias = continuationAlias;

    memory.relationship.girlfriend.aliases = mergeUnique([
      ...memory.relationship.girlfriend.aliases,
      alias,
    ]);

    memory.focus = {
      type: "relationship.girlfriend",
      label: memory.relationship.girlfriend.name || alias,
      updatedAt: new Date().toISOString(),
    };

    upsertFact(memory, {
      key: "relationship.girlfriend.aliases",
      category: "relationship.alias",
      value: `The user may refer to his girlfriend as: ${memory.relationship.girlfriend.aliases.join(", ")}.`,
      confidence: 0.95,
    });

    result.saved.push(`Alias saved: ${alias}.`);
    result.confidence = 0.95;
    result.shouldIntercept = true;
    result.localReply = formatAliasSavedReply(memory, alias);
  }

  if (mentionsRelationshipProblem(message)) {
    upsertRelationshipFact(memory, {
      key: "relationship.active_topic",
      summary: "The user is discussing an active relationship problem.",
      people: knownImportantPeopleNames(memory),
      confidence: 0.68,
      volatile: true,
    });

    upsertFact(memory, {
      key: "relationship.active_topic",
      category: "relationship.issue",
      value: "The user is discussing a problem with his girlfriend.",
      confidence: 0.68,
      volatile: true,
    });

    result.confidence = Math.max(result.confidence, 0.68);
  }

  if (mentionsTrustAndOverthinking(message)) {
    upsertRelationshipFact(memory, {
      key: "relationship.trust_overthinking",
      summary: "Trust and overthinking are important relationship themes for the user.",
      people: knownImportantPeopleNames(memory),
      confidence: 0.92,
    });

    upsertFact(memory, {
      key: "relationship.main_issue",
      category: "relationship.issue",
      value: "With the user's girlfriend, the main issue is trust and overthinking, not just normal jealousy.",
      confidence: 0.92,
    });

    result.saved.push("Relationship theme saved: trust and overthinking.");
    result.confidence = Math.max(result.confidence, 0.92);
    result.shouldIntercept = explicitMemory;
  }

  if (mentionsConcealmentBoundary(message)) {
    upsertRelationshipFact(memory, {
      key: "relationship.trust_boundary",
      summary: "Hiding or concealment breaks trust for the user.",
      people: knownImportantPeopleNames(memory),
      confidence: 0.9,
    });

    upsertFact(memory, {
      key: "relationship.trust_boundary",
      category: "relationship.boundary",
      value: "Hiding/concealment breaks trust for the user. The core issue is concealment, not only the person involved.",
      confidence: 0.9,
    });

    result.saved.push("Trust boundary saved: concealment breaks trust.");
    result.confidence = Math.max(result.confidence, 0.9);
    result.shouldIntercept = explicitMemory;
  }

  if (lower.includes("calm strength")) {
    memory.communicationPreferences.responseStyle = mergeUnique([
      ...memory.communicationPreferences.responseStyle,
      "calm strength",
      "clear boundaries without chasing",
    ]);

    upsertFact(memory, {
      key: "relationship.best_approach",
      category: "relationship.strategy",
      value: "Best approach with the girlfriend: calm strength; make honesty safe, but keep a clear boundary against hiding.",
      confidence: 0.9,
    });

    result.saved.push("Relationship approach saved: calm strength.");
    result.confidence = Math.max(result.confidence, 0.9);
    result.shouldIntercept = explicitMemory;
  }

  if (mentionsAdviceStylePreference(message)) {
    memory.communicationPreferences.tone = "direct";
    memory.communicationPreferences.avoid = mergeUnique([
      ...memory.communicationPreferences.avoid,
      "responses that make the user look weak, begging, controlling, or emotionally chasing",
    ]);

    upsertFact(memory, {
      key: "response_style.relationship",
      category: "communication.style",
      value: "Avoid advice that makes the user look weak, begging, controlling, or emotionally chasing.",
      confidence: 0.9,
    });

    result.saved.push("Advice style preference saved.");
    result.confidence = Math.max(result.confidence, 0.9);
    result.shouldIntercept = explicitMemory;
  }

  if (explicitMemory && result.saved.length === 0) {
    const clean = message
      .replace(/^remember this about me\s*:?/i, "")
      .replace(/^remember this\s*:?/i, "")
      .replace(/^remember\s*:?/i, "")
      .trim();

    if (clean) {
      upsertFact(memory, {
        key: `user.note.${hashText(clean)}`,
        category: "profile.note",
        value: clean,
        confidence: 0.82,
      });

      result.saved.push("General memory saved.");
      result.confidence = Math.max(result.confidence, 0.82);
      result.shouldIntercept = true;
    }
  }

  if (result.saved.length) {
    result.memory = saveMemoryContext(memory);

    if (!result.localReply) {
      result.localReply = formatGenericSavedReply(result.saved);
    }
  }

  return result;
}

export function answerQuestionFromMemory(text, memoryContext = createEmptyMemory()) {
  const memory = normalizeMemory(memoryContext);
  const message = String(text || "").trim();
  const lower = message.toLowerCase();

  if (!message) return "";

  const girlfriend = memory.relationship.girlfriend;
  const aliases = girlfriend.aliases || [];
  const girlfriendName = girlfriend.name || aliases[0] || "";
  const preferredName = memory.preferredName || memory.user.preferredName || "";

  if (
    preferredName &&
    (
      lower.includes("what is my name") ||
      lower.includes("what's my name") ||
      lower.includes("who am i") ||
      lower.includes("اسمي ايه") ||
      lower.includes("اسمي إيه")
    )
  ) {
    return `Your preferred name is ${preferredName}.`;
  }

  if (!girlfriendName && !aliases.length) return "";

  if (
    lower.includes("who is my girlfriend") ||
    lower.includes("what is my girlfriend") ||
    lower.includes("what's my girlfriend") ||
    lower.includes("مين حبيبتي") ||
    lower.includes("اسم حبيبتي")
  ) {
    return `Your girlfriend is ${girlfriendName}. ${aliases.length ? `You may also refer to her as ${aliases.join(", ")}.` : ""}`.trim();
  }

  const whoIsMatch =
    message.match(/^who is\s+["“]?([^"”?]+)["”]?\??$/i) ||
    message.match(/^مين\s+["“]?([^"”؟]+)["”]?[؟?]?$/i);

  if (whoIsMatch) {
    const askedName = normalizeName(whoIsMatch[1]);

    if (isKnownGirlfriendAlias(askedName, memory)) {
      return `${askedName} is one of the names you may use for your girlfriend${girlfriendName ? `, ${girlfriendName}` : ""}.`;
    }
  }

  if (
    lower.includes("what do you remember") ||
    lower.includes("summarize what you remember") ||
    lower.includes("what you know about me and") ||
    lower.includes("فاكر ايه")
  ) {
    return summarizeMemory(memory);
  }

  if (
    (lower.includes("main trust issue") || lower.includes("deleted chat") || lower.includes("concealment")) &&
    getFact(memory, "relationship.trust_boundary")
  ) {
    return getFact(memory, "relationship.trust_boundary").value;
  }

  return "";
}

export function buildMemoryPromptPrefix(memoryContext = createEmptyMemory()) {
  const memory = normalizeMemory(memoryContext);
  const lines = buildMemoryLines(memory);

  if (!lines.length) return "";

  return [
    "Saved user memory:",
    ...lines.map((line) => `- ${line}`),
    "",
    "Assistant instruction:",
    "Use saved memory when answering questions about the user, their girlfriend, aliases, relationship context, preferences, and previous facts.",
    "If the user refers to a known alias, resolve it from memory.",
    "If the user sends a short fragment such as 'or Maya', interpret it as a continuation of the previous relevant memory when memory focus supports that.",
    "Do not say you do not know a fact that is present in saved memory.",
    "",
    "User message:",
  ].join("\n") + "\n";
}

export function buildMemoryLines(memoryContext = createEmptyMemory()) {
  const memory = normalizeMemory(memoryContext);
  const lines = [];

  const girlfriend = memory.relationship.girlfriend;
  const preferredName = memory.preferredName || memory.user.preferredName || "";

  if (preferredName) {
    lines.push(`The user's preferred name is ${preferredName}.`);
  }

  for (const person of memory.importantPeople) {
    const aliases = person.aliases?.filter((alias) => alias !== person.canonicalName) || [];
    const relationship = person.relationship ? ` (${person.relationship})` : "";
    lines.push(
      `${person.canonicalName}${relationship}${aliases.length ? `; aliases: ${aliases.join(", ")}` : ""}.`,
    );
  }

  for (const fact of memory.relationshipFacts) {
    if (fact?.summary && !fact.volatile) {
      lines.push(fact.summary);
    }
  }

  const comm = memory.communicationPreferences;
  if (comm.tone || comm.language) {
    lines.push(`Communication preferences: ${[comm.tone, comm.language].filter(Boolean).join(", ")}.`);
  }

  if (comm.responseStyle.length) {
    lines.push(`Preferred response style: ${comm.responseStyle.join(", ")}.`);
  }

  if (comm.avoid.length || memory.avoidedResponses.length) {
    lines.push(`Avoid responses: ${mergeUnique([...comm.avoid, ...memory.avoidedResponses]).join(", ")}.`);
  }

  if (girlfriend.name) {
    lines.push(`The user's girlfriend is called ${girlfriend.name}.`);
  }

  if (girlfriend.aliases.length) {
    lines.push(`The user may refer to his girlfriend as: ${girlfriend.aliases.join(", ")}.`);
  }

  for (const fact of memory.facts) {
    if (fact?.value && !fact.volatile) {
      lines.push(String(fact.value));
    }
  }

  return mergeUnique(lines).slice(0, 50);
}

export function createEmptyMemory() {
  return {
    version: 2,
    preferredName: "",
    user: {
      preferredName: "",
    },
    importantPeople: [],
    relationshipFacts: [],
    communicationPreferences: {
      tone: "",
      language: "",
      responseStyle: [],
      avoid: [],
    },
    emotionalTriggers: [],
    userGoals: [],
    avoidedResponses: [],
    relationship: {
      girlfriend: {
        name: "",
        aliases: [],
      },
    },
    facts: [],
    focus: null,
    updatedAt: null,
  };
}

function normalizeMemory(value) {
  const base = createEmptyMemory();
  const raw = value && typeof value === "object" ? value : {};

  return {
    ...base,
    ...raw,
    user: {
      ...base.user,
      ...(raw.user || {}),
      preferredName: normalizeNameValue(raw.user?.preferredName || raw.user?.preferred_name || raw.preferredName || raw.preferred_name || ""),
    },
    preferredName: normalizeNameValue(raw.preferredName || raw.preferred_name || raw.user?.preferredName || raw.user?.preferred_name || ""),
    importantPeople: normalizeImportantPeople(raw.importantPeople || raw.important_people || []),
    relationshipFacts: normalizeRelationshipFacts(raw.relationshipFacts || raw.relationship_facts || []),
    communicationPreferences: normalizeCommunicationPreferences(raw.communicationPreferences || raw.communication_preferences || {}),
    emotionalTriggers: normalizeStringList(raw.emotionalTriggers || raw.emotional_triggers || raw.known_triggers || []),
    userGoals: normalizeStringList(raw.userGoals || raw.user_goals || raw.goals || []),
    avoidedResponses: normalizeStringList(raw.avoidedResponses || raw.avoided_responses || []),
    relationship: {
      ...base.relationship,
      ...(raw.relationship || {}),
      girlfriend: {
        ...base.relationship.girlfriend,
        ...(raw.relationship?.girlfriend || {}),
        aliases: Array.isArray(raw.relationship?.girlfriend?.aliases)
          ? raw.relationship.girlfriend.aliases.map(normalizeName).filter(Boolean)
          : [],
      },
    },
    facts: Array.isArray(raw.facts) ? raw.facts : [],
    focus: raw.focus || null,
  };
}

export function mergeMemoryContexts(existingContext = createEmptyMemory(), incomingContext = createEmptyMemory()) {
  const existing = normalizeMemory(existingContext);
  const incoming = normalizeMemory(incomingContext);
  const merged = normalizeMemory(existing);

  merged.preferredName = incoming.preferredName || existing.preferredName;
  merged.user.preferredName = merged.preferredName || incoming.user.preferredName || existing.user.preferredName || "";

  merged.importantPeople = mergeImportantPeopleForContext(
    existing.importantPeople,
    incoming.importantPeople,
  );

  merged.relationshipFacts = mergeRelationshipFactsForContext(
    existing.relationshipFacts,
    incoming.relationshipFacts,
  );

  merged.communicationPreferences = {
    tone: incoming.communicationPreferences.tone || existing.communicationPreferences.tone,
    language: incoming.communicationPreferences.language || existing.communicationPreferences.language,
    responseStyle: mergeUnique([
      ...existing.communicationPreferences.responseStyle,
      ...incoming.communicationPreferences.responseStyle,
    ]),
    avoid: mergeUnique([
      ...existing.communicationPreferences.avoid,
      ...incoming.communicationPreferences.avoid,
    ]),
  };

  merged.emotionalTriggers = mergeUnique([
    ...existing.emotionalTriggers,
    ...incoming.emotionalTriggers,
  ]);

  merged.userGoals = mergeUnique([
    ...existing.userGoals,
    ...incoming.userGoals,
  ]);

  merged.avoidedResponses = mergeUnique([
    ...existing.avoidedResponses,
    ...incoming.avoidedResponses,
  ]);

  merged.facts = mergeFactsForContext(existing.facts, incoming.facts);

  const existingGirlfriend = existing.relationship.girlfriend;
  const incomingGirlfriend = incoming.relationship.girlfriend;

  merged.relationship.girlfriend = {
    name: incomingGirlfriend.name || existingGirlfriend.name,
    aliases: mergeUnique([
      existingGirlfriend.name,
      ...existingGirlfriend.aliases,
      incomingGirlfriend.name,
      ...incomingGirlfriend.aliases,
    ]),
  };

  if (!merged.relationship.girlfriend.name && merged.relationship.girlfriend.aliases.length) {
    merged.relationship.girlfriend.name = merged.relationship.girlfriend.aliases[0];
  }

  merged.focus = incoming.focus || existing.focus || null;
  merged.updatedAt = new Date().toISOString();

  return normalizeMemory(merged);
}

function mergeImportantPeopleForContext(existingPeople = [], incomingPeople = []) {
  const merged = [];

  for (const person of [...existingPeople, ...incomingPeople]) {
    if (!person || typeof person !== "object") continue;

    const canonicalName = normalizeNameValue(person.canonicalName || person.canonical_name || person.name || "");
    if (!canonicalName) continue;

    const next = {
      canonicalName,
      aliases: mergeUnique([canonicalName, ...(person.aliases || [])]),
      relationship: String(person.relationship || "").trim().toLowerCase(),
      notes: normalizeStringList(person.notes || []),
      confidence: Number(person.confidence || 0.7),
      updatedAt: person.updatedAt || person.updated_at || new Date().toISOString(),
    };

    const nextAliases = new Set(next.aliases.map((alias) => normalizeNameValue(alias).toLowerCase()));
    const existingIndex = merged.findIndex((item) => {
      const aliases = new Set([item.canonicalName, ...(item.aliases || [])].map((alias) => normalizeNameValue(alias).toLowerCase()));
      const aliasMatch = [...nextAliases].some((alias) => aliases.has(alias));
      const relationshipMatch = next.relationship && item.relationship === next.relationship;
      return aliasMatch || relationshipMatch;
    });

    if (existingIndex < 0) {
      merged.push(next);
      continue;
    }

    const current = merged[existingIndex];
    merged[existingIndex] = {
      ...current,
      aliases: mergeUnique([...(current.aliases || []), ...next.aliases]),
      relationship: next.relationship || current.relationship,
      notes: mergeUnique([...(current.notes || []), ...next.notes]),
      confidence: Math.max(Number(current.confidence || 0), next.confidence),
      updatedAt: next.updatedAt,
    };
  }

  return merged.slice(0, 80);
}

function mergeRelationshipFactsForContext(existingFacts = [], incomingFacts = []) {
  const merged = [];
  const seen = new Set();

  for (const fact of [...existingFacts, ...incomingFacts]) {
    if (!fact || typeof fact !== "object") continue;

    const summary = String(fact.summary || fact.value || "").trim();
    if (!summary) continue;

    const key = fact.key || `relationship.${hashText(summary)}`;
    const dedupeKey = `${key}:${summary.toLowerCase()}`;

    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    merged.push({
      key,
      summary,
      people: normalizeStringList(fact.people || []),
      confidence: Number(fact.confidence || 0.65),
      volatile: Boolean(fact.volatile),
      updatedAt: fact.updatedAt || fact.updated_at || new Date().toISOString(),
    });
  }

  return merged.slice(0, 80);
}

function mergeFactsForContext(existingFacts = [], incomingFacts = []) {
  const mergedByKey = new Map();

  for (const fact of [...existingFacts, ...incomingFacts]) {
    if (!fact || typeof fact !== "object") continue;

    const value = String(fact.value || fact.text || "").trim();
    if (!value) continue;

    const key = fact.key || fact?.metadata?.key || `fact.${hashText(value)}`;

    const next = {
      key,
      category: fact.category || "profile.fact",
      value,
      confidence: Number(fact.confidence || 0.7),
      volatile: Boolean(fact.volatile),
      updatedAt: fact.updatedAt || fact.updated_at || fact.created_at || new Date().toISOString(),
    };

    const current = mergedByKey.get(key);
    if (!current || next.confidence >= Number(current.confidence || 0)) {
      mergedByKey.set(key, next);
    }
  }

  return [...mergedByKey.values()].slice(0, 80);
}

export function memoryToBackendSummary(memoryContext, userIdHash = "client") {
  const memory = normalizeMemory(memoryContext);

  return {
    user_id_hash: userIdHash || "client",
    preferred_name: memory.preferredName || null,
    important_people: memory.importantPeople.map((person) => ({
      canonical_name: person.canonicalName,
      aliases: person.aliases,
      relationship: person.relationship,
      notes: person.notes || [],
      confidence: person.confidence,
    })),
    relationship_facts: memory.relationshipFacts
      .filter((fact) => !fact.volatile)
      .map((fact) => ({
        summary: fact.summary,
        people: fact.people || [],
        confidence: fact.confidence,
      })),
    communication_preferences: {
      tone: memory.communicationPreferences.tone,
      language: memory.communicationPreferences.language,
      response_style: memory.communicationPreferences.responseStyle,
      avoid: memory.communicationPreferences.avoid,
    },
    emotional_triggers: memory.emotionalTriggers,
    user_goals: memory.userGoals,
    avoided_responses: memory.avoidedResponses,
    summary: buildMemoryLines(memory).slice(0, 12).map((line) => `- ${line}`).join("\n"),
    known_triggers: memory.emotionalTriggers,
    preferred_coping_tools: [],
    goals: memory.userGoals,
    preferences: [
      ...memory.communicationPreferences.responseStyle,
      memory.communicationPreferences.tone,
      memory.communicationPreferences.language,
    ].filter(Boolean),
    safety_flags: [],
    items: memory.facts
      .filter((fact) => fact?.value && !fact.volatile)
      .slice(0, 40)
      .map((fact) => ({
        category: categoryToBackend(fact.category),
        text: String(fact.value).slice(0, 700),
        source: "manual",
        sensitivity: "medium",
        confidence: Number(fact.confidence || 0.7),
        tags: [String(fact.category || "other")],
        metadata: { key: fact.key || "" },
      })),
    source: "manual",
    version: 2,
  };
}

export function memoryFromBackendSummary(summary) {
  const raw = summary && typeof summary === "object" ? summary : {};
  const memory = createEmptyMemory();

  memory.preferredName = normalizeNameValue(raw.preferred_name || "");
  memory.user.preferredName = memory.preferredName;
  memory.importantPeople = normalizeImportantPeople(raw.important_people || []);
  memory.relationshipFacts = normalizeRelationshipFacts(raw.relationship_facts || []);
  memory.communicationPreferences = normalizeCommunicationPreferences(raw.communication_preferences || {});
  memory.emotionalTriggers = normalizeStringList(raw.emotional_triggers || raw.known_triggers || []);
  memory.userGoals = normalizeStringList(raw.user_goals || raw.goals || []);
  memory.avoidedResponses = normalizeStringList(raw.avoided_responses || []);
  memory.facts = Array.isArray(raw.items)
    ? raw.items.map((item, index) => ({
      key: item?.metadata?.key || `backend.item.${index}`,
      category: item?.category || "other",
      value: item?.text || "",
      confidence: Number(item?.confidence || 0.6),
      volatile: false,
      updatedAt: item?.created_at || new Date().toISOString(),
    })).filter((item) => item.value)
    : [];

  const girlfriend = memory.importantPeople.find((person) => person.relationship === "girlfriend");
  if (girlfriend) {
    memory.relationship.girlfriend.name = girlfriend.canonicalName;
    memory.relationship.girlfriend.aliases = girlfriend.aliases;
  }

  return normalizeMemory(memory);
}

export function getMemoryInspectorRows(memoryContext = createEmptyMemory()) {
  const memory = normalizeMemory(memoryContext);
  const rows = [];

  if (memory.preferredName) {
    rows.push({ key: "preferred_name", label: "Name", value: memory.preferredName });
  }

  for (const person of memory.importantPeople) {
    rows.push({
      key: `person.${person.canonicalName}`,
      label: titleCase(person.relationship || "Person"),
      value: [person.canonicalName, ...(person.aliases || []).filter((alias) => alias !== person.canonicalName)].join(" / "),
    });
  }

  const comm = memory.communicationPreferences;
  if (comm.tone || comm.language || comm.responseStyle.length) {
    rows.push({
      key: "communication",
      label: "Preference",
      value: [comm.tone, comm.language, ...comm.responseStyle].filter(Boolean).join(", "),
    });
  }

  for (const fact of memory.relationshipFacts.filter((item) => !item.volatile).slice(0, 6)) {
    rows.push({ key: fact.key || fact.summary, label: "Relationship", value: fact.summary });
  }

  for (const avoided of memory.avoidedResponses.slice(0, 6)) {
    rows.push({ key: `avoid.${avoided}`, label: "Avoid", value: avoided });
  }

  return rows;
}

function extractGirlfriendNameAndAliases(message) {
  const result = {
    name: "",
    aliases: [],
  };

  const nameMatch =
    message.match(/my girlfriend\s+(?:is\s+)?(?:called|named)\s+([^.,\n]+)/i) ||
    message.match(/girlfriend\s+(?:is\s+)?(?:called|named)\s+([^.,\n]+)/i) ||
    message.match(/حبيبتي\s+(?:اسمها|اسمها\s+هو)\s+([^.,\n]+)/i);

  if (nameMatch) {
    result.name = normalizeName(nameMatch[1]);
  }

  const aliasMatch =
    message.match(/may write (?:her|his|their) name as\s+(.+)$/i) ||
    message.match(/I may write (?:her|his|their) name as\s+(.+)$/i) ||
    message.match(/(?:write|call) (?:her|him|them) as\s+(.+)$/i);

  if (aliasMatch) {
    result.aliases = extractAliases(aliasMatch[1]);
  }

  if (result.name) {
    result.aliases = mergeUnique([result.name, ...result.aliases]);
  }

  return result;
}

function extractPreferredName(message) {
  const match =
    message.match(/\b(?:my name is|call me|i am called|i'm called|my preferred name is)\s+([^.,\n]+)/i) ||
    message.match(/(?:اسمي|ناديني|اسمي هو)\s+([^.,،\n]+)/i);

  return match ? normalizeNameValue(match[1]) : "";
}

function extractContinuationAlias(message) {
  const match =
    message.match(/^or\s+["“]?([^"”\n]+)["”]?\.?$/i) ||
    message.match(/^او\s+["“]?([^"”\n]+)["”]?\.?$/i) ||
    message.match(/^أو\s+["“]?([^"”\n]+)["”]?\.?$/i);

  if (!match) return "";

  return normalizeName(match[1]);
}

function isLikelyRelationshipContinuation(memory, recentMessages) {
  if (memory.focus?.type === "relationship.girlfriend") return true;

  if (memory.relationship.girlfriend.name || memory.relationship.girlfriend.aliases.length) {
    return true;
  }

  const recentText = Array.isArray(recentMessages)
    ? recentMessages.slice(-4).map((item) => item.text || item.content || "").join(" ").toLowerCase()
    : "";

  return (
    recentText.includes("girlfriend") ||
    recentText.includes("حبيبتي") ||
    recentText.includes("مي")
  );
}

function mentionsRelationshipProblem(message) {
  const lower = message.toLowerCase();

  return (
    lower.includes("problem with my girlfriend") ||
    lower.includes("girlfriend problem") ||
    lower.includes("relationship problem") ||
    message.includes("مشكلة مع حبيبتي") ||
    message.includes("مشاكل مع حبيبتي")
  );
}

function mentionsTrustAndOverthinking(message) {
  const lower = message.toLowerCase();

  return (
    lower.includes("trust") && lower.includes("overthinking")
  ) || (
    message.includes("ثقة") && (message.includes("تفكير") || message.includes("اوفرثينك"))
  );
}

function mentionsConcealmentBoundary(message) {
  const lower = message.toLowerCase();

  return (
    lower.includes("hid") ||
    lower.includes("hidden") ||
    lower.includes("deleted chat") ||
    lower.includes("concealment") ||
    lower.includes("hiding breaks trust") ||
    message.includes("خبي") ||
    message.includes("خبت") ||
    message.includes("مخبي")
  );
}

function mentionsAdviceStylePreference(message) {
  const lower = message.toLowerCase();

  return (
    lower.includes("weak") ||
    lower.includes("begging") ||
    lower.includes("controlling") ||
    lower.includes("emotionally chasing") ||
    message.includes("ضعيف") ||
    message.includes("بتحكم") ||
    message.includes("توسل")
  );
}

function isExplicitMemoryCommand(lower) {
  return (
    lower.startsWith("remember this") ||
    lower.startsWith("remember:") ||
    lower.startsWith("remember ") ||
    lower.includes("remember this about me")
  );
}

function extractAliases(value) {
  return String(value || "")
    .split(/\s+or\s+|,|\/|،/i)
    .map(normalizeName)
    .filter(Boolean);
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.،,!?؟]+$/g, "");
}

function normalizeNameValue(value) {
  return String(value || "")
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.،,!?؟]+$/g, "");
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
    .replace(/[^\w\u0600-\u06ff\s-]+/g, " ")
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

function hashString(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function extractProject(message) {
  const match =
    message.match(/\bmy project is\s+([^.,!?\n]+)/i) ||
    message.match(/\b(?:i am working on|i'm working on)\s+([^.,!?\n]+)/i);
  return match ? normalizeNameValue(match[1]) : "";
}

function extractGraphPreferences(message) {
  const values = [];
  const preferMatch = message.match(/\bI prefer\s+([^.,!?\n]+)/i);
  const pleaseMatch = message.match(/\bplease be\s+([^.,!?\n]+)/i);
  if (preferMatch) values.push(normalizeNameValue(preferMatch[1]));
  if (pleaseMatch) values.push(normalizeNameValue(pleaseMatch[1]));
  if (/\b(direct answers|be direct|no fluff|concise)\b/i.test(message)) values.push("direct answers");
  return mergeUnique(values);
}

function extractGraphAvoid(message) {
  const values = [];
  for (const pattern of [/\bavoid\s+([^.,!?\n]+)/i, /\bdo not answer like\s+([^.,!?\n]+)/i, /\bdon't answer like\s+([^.,!?\n]+)/i]) {
    const match = message.match(pattern);
    if (match) values.push(normalizeAvoidValue(match[1]));
  }
  return mergeUnique(values);
}

function normalizeAvoidValue(value) {
  let cleaned = normalizeNameValue(value).replace(/^(being|be|too)\s+/i, "").trim();
  if (cleaned && !/(responses|style)$/i.test(cleaned) && cleaned.split(/\s+/).length <= 3) {
    cleaned = `${cleaned} responses`;
  }
  return cleaned;
}

function upsertFact(memory, fact) {
  const key = fact.key;
  const existing = memory.facts.find((item) => item.key === key);

  const next = {
    key,
    category: fact.category || "profile.fact",
    value: fact.value,
    confidence: Number(fact.confidence || 0.7),
    volatile: Boolean(fact.volatile),
    updatedAt: new Date().toISOString(),
  };

  if (existing) {
    Object.assign(existing, next);
  } else {
    memory.facts.push(next);
  }
}

function upsertImportantPerson(memory, person) {
  const canonicalName = normalizeNameValue(person.canonicalName);

  if (!canonicalName) return;

  const next = {
    canonicalName,
    aliases: mergeUnique([canonicalName, ...(person.aliases || [])]),
    relationship: String(person.relationship || "").trim().toLowerCase(),
    notes: normalizeStringList(person.notes || []),
    confidence: Number(person.confidence || 0.7),
    updatedAt: new Date().toISOString(),
  };

  const candidateAliases = new Set(next.aliases.map((alias) => alias.toLowerCase()));
  const existing = memory.importantPeople.find((item) => {
    const aliases = new Set([item.canonicalName, ...(item.aliases || [])].map((alias) => normalizeNameValue(alias).toLowerCase()));
    return [...candidateAliases].some((alias) => aliases.has(alias));
  });

  if (existing) {
    existing.aliases = mergeUnique([...(existing.aliases || []), ...next.aliases]);
    existing.relationship = next.relationship || existing.relationship;
    existing.notes = mergeUnique([...(existing.notes || []), ...next.notes]);
    existing.confidence = Math.max(Number(existing.confidence || 0), next.confidence);
    existing.updatedAt = next.updatedAt;
  } else {
    memory.importantPeople.push(next);
  }
}

function upsertRelationshipFact(memory, fact) {
  const key = fact.key || `relationship.${hashText(fact.summary || "")}`;
  const summary = String(fact.summary || "").trim();

  if (!summary) return;

  const existing = memory.relationshipFacts.find((item) => item.key === key);
  const next = {
    key,
    summary,
    people: normalizeStringList(fact.people || []),
    confidence: Number(fact.confidence || 0.65),
    volatile: Boolean(fact.volatile),
    updatedAt: new Date().toISOString(),
  };

  if (existing) {
    Object.assign(existing, next);
  } else {
    memory.relationshipFacts.push(next);
  }
}

function knownImportantPeopleNames(memory) {
  return memory.importantPeople.map((person) => person.canonicalName).filter(Boolean);
}

function getFact(memory, key) {
  return memory.facts.find((fact) => fact.key === key) || null;
}

function isKnownGirlfriendAlias(name, memory) {
  const clean = normalizeName(name).toLowerCase();

  if (!clean) return false;

  const girlfriend = memory.relationship.girlfriend;

  return [girlfriend.name, ...girlfriend.aliases]
    .filter(Boolean)
    .some((alias) => normalizeName(alias).toLowerCase() === clean);
}

function formatGirlfriendSavedReply(memory, saved) {
  const name = saved.name || memory.relationship.girlfriend.name;
  const aliases = memory.relationship.girlfriend.aliases || [];

  if (aliases.length > 1) {
    return `Got it — ${name} is your girlfriend, and I’ll understand ${aliases.join(", ")} as names/references for her. Tell me what’s happening with her.`;
  }

  return `Got it — ${name} is your girlfriend. Tell me what’s happening with her.`;
}

function formatAliasSavedReply(memory, alias) {
  const name = memory.relationship.girlfriend.name || "your girlfriend";
  return `Got it — ${alias} is another name/reference you may use for ${name}.`;
}

function formatGenericSavedReply(saved) {
  if (saved.length === 1) {
    return `Saved — ${saved[0]}`;
  }

  return `Saved:\n${saved.map((item) => `- ${item}`).join("\n")}`;
}

function summarizeMemory(memory) {
  const lines = buildMemoryLines(memory);

  if (!lines.length) {
    return "I do not have saved memory about that yet.";
  }

  return `Here is what I remember:\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

function normalizeStringList(value) {
  const raw = Array.isArray(value) ? value : (value ? [value] : []);
  return mergeUnique(raw.map((item) => String(item || "").trim()).filter(Boolean));
}

function normalizeImportantPeople(value) {
  if (!Array.isArray(value)) return [];

  const output = [];

  for (const item of value) {
    if (!item || typeof item !== "object") continue;

    const canonicalName = normalizeNameValue(item.canonicalName || item.canonical_name || item.name || "");
    if (!canonicalName) continue;

    output.push({
      canonicalName,
      aliases: mergeUnique([canonicalName, ...(item.aliases || [])]),
      relationship: String(item.relationship || "").trim().toLowerCase(),
      notes: normalizeStringList(item.notes || []),
      confidence: Number(item.confidence || 0.7),
      updatedAt: item.updatedAt || item.updated_at || new Date().toISOString(),
    });
  }

  return output.slice(0, 80);
}

function normalizeRelationshipFacts(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;

      const summary = String(item.summary || item.value || "").trim();
      if (!summary) return null;

      return {
        key: item.key || `relationship.${hashText(summary)}.${index}`,
        summary,
        people: normalizeStringList(item.people || []),
        confidence: Number(item.confidence || 0.65),
        volatile: Boolean(item.volatile),
        updatedAt: item.updatedAt || item.updated_at || new Date().toISOString(),
      };
    })
    .filter(Boolean)
    .slice(0, 80);
}

function normalizeCommunicationPreferences(value) {
  const raw = value && typeof value === "object" ? value : {};

  return {
    tone: String(raw.tone || "").trim(),
    language: String(raw.language || "").trim(),
    responseStyle: normalizeStringList(raw.responseStyle || raw.response_style || []),
    avoid: normalizeStringList(raw.avoid || []),
  };
}

function categoryToBackend(category) {
  const value = String(category || "").toLowerCase();

  if (value.includes("trigger")) return "trigger";
  if (value.includes("goal")) return "goal";
  if (value.includes("preference") || value.includes("style")) return "preference";
  if (value.includes("relationship")) return "support_context";
  if (value.includes("safety")) return "safety_flag";
  return "other";
}

function titleCase(value) {
  return String(value || "Memory")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function mergeUnique(values) {
  const seen = new Set();
  const out = [];

  for (const value of values) {
    const clean = normalizeName(value);
    const key = clean.toLowerCase();

    if (!clean || seen.has(key)) continue;

    seen.add(key);
    out.push(clean);
  }

  return out;
}

function hashText(text) {
  let hash = 0;
  const value = String(text || "");

  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash).toString(36);
}
