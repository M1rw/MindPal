// frontend/js/utils/memory_helpers.js — Shared utilities for memory modules

// ═══════════════════════════════════════════════════════════════
// String normalization
// ═══════════════════════════════════════════════════════════════

export function normalizeName(value) {
  return String(value || "")
    .trim()
    .replace(/^["'""]+|["'""]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.،,!?؟]+$/g, "");
}

export function normalizeNameValue(value) {
  return String(value || "")
    .trim()
    .replace(/^["'""]+|["'""]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.،,!?؟]+$/g, "");
}

export function normalizeStringList(value) {
  const raw = Array.isArray(value) ? value : (value ? [value] : []);
  return mergeUnique(raw.map((item) => String(item || "").trim()).filter(Boolean));
}



// ═══════════════════════════════════════════════════════════════
// Deduplication
// ═══════════════════════════════════════════════════════════════

export function mergeUnique(values) {
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

// ═══════════════════════════════════════════════════════════════
// Hashing
// ═══════════════════════════════════════════════════════════════

export function hashString(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}



// ═══════════════════════════════════════════════════════════════
// Memory command detection
// ═══════════════════════════════════════════════════════════════

export function isExplicitMemoryCommand(lower) {
  return (
    lower.startsWith("remember this") ||
    lower.startsWith("remember:") ||
    lower.startsWith("remember ") ||
    lower.includes("remember this about me")
  );
}

// ═══════════════════════════════════════════════════════════════
// Reply formatting
// ═══════════════════════════════════════════════════════════════

export function formatGenericSavedReply(saved) {
  if (saved.length === 1) {
    return `Saved — ${saved[0]}`;
  }

  return `Saved:\n${saved.map((item) => `- ${item}`).join("\n")}`;
}

// ═══════════════════════════════════════════════════════════════
// Message extraction (used by both graph and legacy modules)
// ═══════════════════════════════════════════════════════════════

export function extractPreferredName(message) {
  const match =
    message.match(/\b(?:my name is|call me|i am called|i'm called|my preferred name is)\s+([^.,\n]+)/i) ||
    message.match(/(?:اسمي|ناديني|اسمي هو)\s+([^.,،\n]+)/i);

  return match ? normalizeNameValue(match[1]) : "";
}

export function extractGirlfriendNameAndAliases(message) {
  const result = { name: "", aliases: [] };

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

export function extractProject(message) {
  const match =
    message.match(/\bmy project is\s+([^.,!?\n]+)/i) ||
    message.match(/\b(?:i am working on|i'm working on)\s+([^.,!?\n]+)/i);
  return match ? normalizeNameValue(match[1]) : "";
}

export function extractGraphPreferences(message) {
  const values = [];
  const preferMatch = message.match(/\bI prefer\s+([^.,!?\n]+)/i);
  const pleaseMatch = message.match(/\bplease be\s+([^.,!?\n]+)/i);
  if (preferMatch) values.push(normalizeNameValue(preferMatch[1]));
  if (pleaseMatch) values.push(normalizeNameValue(pleaseMatch[1]));
  if (/\b(direct answers|be direct|no fluff|concise)\b/i.test(message)) values.push("direct answers");
  return mergeUnique(values);
}

export function extractGraphAvoid(message) {
  const values = [];
  for (const pattern of [/\bavoid\s+([^.,!?\n]+)/i, /\bdo not answer like\s+([^.,!?\n]+)/i, /\bdon't answer like\s+([^.,!?\n]+)/i]) {
    const match = message.match(pattern);
    if (match) values.push(normalizeAvoidValue(match[1]));
  }
  return mergeUnique(values);
}

export function normalizeAvoidValue(value) {
  let cleaned = normalizeNameValue(value).replace(/^(being|be|too)\s+/i, "").trim();
  if (cleaned && !/(responses|style)$/i.test(cleaned) && cleaned.split(/\s+/).length <= 3) {
    cleaned = `${cleaned} responses`;
  }
  return cleaned;
}

function extractAliases(value) {
  return String(value || "")
    .split(/\s+or\s+|,|\/|،/i)
    .map(normalizeName)
    .filter(Boolean);
}
