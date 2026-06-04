// frontend/js/memory_engine.js

const MEMORY_STORAGE_KEY = "mindpal_memory_engine_v1";

export function loadMemoryContext() {
  try {
    const raw = localStorage.getItem(MEMORY_STORAGE_KEY);

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

  const girlfriendSave = extractGirlfriendNameAndAliases(message);

  if (girlfriendSave.name) {
    memory.relationship.girlfriend.name = girlfriendSave.name;
    memory.relationship.girlfriend.aliases = mergeUnique([
      ...memory.relationship.girlfriend.aliases,
      girlfriendSave.name,
      ...girlfriendSave.aliases,
    ]);

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

function createEmptyMemory() {
  return {
    version: 1,
    user: {},
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
    },
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
