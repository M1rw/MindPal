// frontend/js/memory_legacy.js — Legacy flat memory system (backward compat + cloud sync)

import {
  hashText,
  mergeUnique,
  normalizeName,
  normalizeNameValue,
  normalizeStringList,
  categoryToBackend,
  isExplicitMemoryCommand,
  formatGenericSavedReply,
  extractPreferredName,
  extractGirlfriendNameAndAliases,
  extractContinuationAlias,
} from "./utils/memory_helpers.js";

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

const MEMORY_STORAGE_KEY = "mindpal_memory_engine_v2";
const LEGACY_MEMORY_STORAGE_KEY = "mindpal_memory_engine_v1";

// ═══════════════════════════════════════════════════════════════
// CRUD
// ═══════════════════════════════════════════════════════════════

export function createEmptyMemory() {
  return {
    version: 2,
    preferredName: "",
    user: { preferredName: "" },
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
      girlfriend: { name: "", aliases: [] },
    },
    facts: [],
    focus: null,
    updatedAt: null,
  };
}

export function loadMemoryContext() {
  try {
    const raw = localStorage.getItem(MEMORY_STORAGE_KEY) || localStorage.getItem(LEGACY_MEMORY_STORAGE_KEY);
    if (!raw) return createEmptyMemory();
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

// ═══════════════════════════════════════════════════════════════
// Normalization
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// Classify
// ═══════════════════════════════════════════════════════════════

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

  if (!message) return result;

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

// ═══════════════════════════════════════════════════════════════
// Query
// ═══════════════════════════════════════════════════════════════

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
    (lower.includes("what is my name") || lower.includes("what's my name") ||
     lower.includes("who am i") || lower.includes("اسمي ايه") || lower.includes("اسمي إيه"))
  ) {
    return `Your preferred name is ${preferredName}.`;
  }

  if (!girlfriendName && !aliases.length) return "";

  if (
    lower.includes("who is my girlfriend") || lower.includes("what is my girlfriend") ||
    lower.includes("what's my girlfriend") || lower.includes("مين حبيبتي") || lower.includes("اسم حبيبتي")
  ) {
    return `Your girlfriend is ${girlfriendName}. ${aliases.length ? `You may also refer to her as ${aliases.join(", ")}.` : ""}`.trim();
  }

  const whoIsMatch =
    message.match(/^who is\s+[""]?([^""?]+)[""]?\??$/i) ||
    message.match(/^مين\s+[""]?([^""؟]+)[""]?[؟?]?$/i);

  if (whoIsMatch) {
    const askedName = normalizeName(whoIsMatch[1]);
    if (isKnownGirlfriendAlias(askedName, memory)) {
      return `${askedName} is one of the names you may use for your girlfriend${girlfriendName ? `, ${girlfriendName}` : ""}.`;
    }
  }

  if (
    lower.includes("what do you remember") || lower.includes("summarize what you remember") ||
    lower.includes("what you know about me and") || lower.includes("فاكر ايه")
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

export function buildMemoryLines(memoryContext = createEmptyMemory()) {
  const memory = normalizeMemory(memoryContext);
  const lines = [];

  const girlfriend = memory.relationship.girlfriend;
  const preferredName = memory.preferredName || memory.user.preferredName || "";

  if (preferredName) lines.push(`The user's preferred name is ${preferredName}.`);

  for (const person of memory.importantPeople) {
    const aliases = person.aliases?.filter((alias) => alias !== person.canonicalName) || [];
    const relationship = person.relationship ? ` (${person.relationship})` : "";
    lines.push(`${person.canonicalName}${relationship}${aliases.length ? `; aliases: ${aliases.join(", ")}` : ""}.`);
  }

  for (const fact of memory.relationshipFacts) {
    if (fact?.summary && !fact.volatile) lines.push(fact.summary);
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
  if (girlfriend.name) lines.push(`The user's girlfriend is called ${girlfriend.name}.`);
  if (girlfriend.aliases.length) lines.push(`The user may refer to his girlfriend as: ${girlfriend.aliases.join(", ")}.`);

  for (const fact of memory.facts) {
    if (fact?.value && !fact.volatile) lines.push(String(fact.value));
  }

  return mergeUnique(lines).slice(0, 50);
}

// ═══════════════════════════════════════════════════════════════
// Merge
// ═══════════════════════════════════════════════════════════════

export function mergeMemoryContexts(existingContext = createEmptyMemory(), incomingContext = createEmptyMemory()) {
  const existing = normalizeMemory(existingContext);
  const incoming = normalizeMemory(incomingContext);
  const merged = normalizeMemory(existing);

  merged.preferredName = incoming.preferredName || existing.preferredName;
  merged.user.preferredName = merged.preferredName || incoming.user.preferredName || existing.user.preferredName || "";

  merged.importantPeople = mergeImportantPeopleForContext(existing.importantPeople, incoming.importantPeople);
  merged.relationshipFacts = mergeRelationshipFactsForContext(existing.relationshipFacts, incoming.relationshipFacts);

  merged.communicationPreferences = {
    tone: incoming.communicationPreferences.tone || existing.communicationPreferences.tone,
    language: incoming.communicationPreferences.language || existing.communicationPreferences.language,
    responseStyle: mergeUnique([...existing.communicationPreferences.responseStyle, ...incoming.communicationPreferences.responseStyle]),
    avoid: mergeUnique([...existing.communicationPreferences.avoid, ...incoming.communicationPreferences.avoid]),
  };

  merged.emotionalTriggers = mergeUnique([...existing.emotionalTriggers, ...incoming.emotionalTriggers]);
  merged.userGoals = mergeUnique([...existing.userGoals, ...incoming.userGoals]);
  merged.avoidedResponses = mergeUnique([...existing.avoidedResponses, ...incoming.avoidedResponses]);
  merged.facts = mergeFactsForContext(existing.facts, incoming.facts);

  const existingGirlfriend = existing.relationship.girlfriend;
  const incomingGirlfriend = incoming.relationship.girlfriend;

  merged.relationship.girlfriend = {
    name: incomingGirlfriend.name || existingGirlfriend.name,
    aliases: mergeUnique([
      existingGirlfriend.name, ...existingGirlfriend.aliases,
      incomingGirlfriend.name, ...incomingGirlfriend.aliases,
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

// ═══════════════════════════════════════════════════════════════
// Backend conversion
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════

function isLikelyRelationshipContinuation(memory, recentMessages) {
  if (memory.focus?.type === "relationship.girlfriend") return true;
  if (memory.relationship.girlfriend.name || memory.relationship.girlfriend.aliases.length) return true;
  const recentText = Array.isArray(recentMessages)
    ? recentMessages.slice(-4).map((item) => item.text || item.content || "").join(" ").toLowerCase()
    : "";
  return recentText.includes("girlfriend") || recentText.includes("حبيبتي") || recentText.includes("مي");
}

function mentionsRelationshipProblem(message) {
  const lower = message.toLowerCase();
  return (
    lower.includes("problem with my girlfriend") || lower.includes("girlfriend problem") ||
    lower.includes("relationship problem") || message.includes("مشكلة مع حبيبتي") || message.includes("مشاكل مع حبيبتي")
  );
}

function mentionsTrustAndOverthinking(message) {
  const lower = message.toLowerCase();
  return (lower.includes("trust") && lower.includes("overthinking")) ||
    (message.includes("ثقة") && (message.includes("تفكير") || message.includes("اوفرثينك")));
}

function mentionsConcealmentBoundary(message) {
  const lower = message.toLowerCase();
  return (
    lower.includes("hid") || lower.includes("hidden") || lower.includes("deleted chat") ||
    lower.includes("concealment") || lower.includes("hiding breaks trust") ||
    message.includes("خبي") || message.includes("خبت") || message.includes("مخبي")
  );
}

function mentionsAdviceStylePreference(message) {
  const lower = message.toLowerCase();
  return (
    lower.includes("weak") || lower.includes("begging") || lower.includes("controlling") ||
    lower.includes("emotionally chasing") || message.includes("ضعيف") || message.includes("بتحكم") || message.includes("توسل")
  );
}

function isKnownGirlfriendAlias(name, memory) {
  const clean = normalizeName(name).toLowerCase();
  if (!clean) return false;
  const girlfriend = memory.relationship.girlfriend;
  return [girlfriend.name, ...girlfriend.aliases].filter(Boolean).some((alias) => normalizeName(alias).toLowerCase() === clean);
}

function knownImportantPeopleNames(memory) {
  return memory.importantPeople.map((person) => person.canonicalName).filter(Boolean);
}

function getFact(memory, key) {
  return memory.facts.find((fact) => fact.key === key) || null;
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

function formatGirlfriendSavedReply(memory, saved) {
  const name = saved.name || memory.relationship.girlfriend.name;
  const aliases = memory.relationship.girlfriend.aliases || [];
  if (aliases.length > 1) {
    return `Got it — ${name} is your girlfriend, and I'll understand ${aliases.join(", ")} as names/references for her. Tell me what's happening with her.`;
  }
  return `Got it — ${name} is your girlfriend. Tell me what's happening with her.`;
}

function formatAliasSavedReply(memory, alias) {
  const name = memory.relationship.girlfriend.name || "your girlfriend";
  return `Got it — ${alias} is another name/reference you may use for ${name}.`;
}

function summarizeMemory(memory) {
  const lines = buildMemoryLines(memory);
  if (!lines.length) return "I do not have saved memory about that yet.";
  return `Here is what I remember:\n${lines.map((line) => `- ${line}`).join("\n")}`;
}
