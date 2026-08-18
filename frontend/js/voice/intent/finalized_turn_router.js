import { isVoiceLocalTimeRequest, requiresVerifiedVoiceEvidence } from "../conversation_policy.js";
import { selectVoiceResponsePlan } from "../response_director.js";

const MEMORY_RE = /\b(?:do you remember|remember when|my name|what(?:'s| is) my|what do you know about me|my preference|my goal|my memory|past conversation|earlier we)\b|(?:فاكر|تفتكر|اسمي|حاجات عني|اللي اتكلمنا عنه|قبل كده)/i;
const CALC_RE = /\b(?:calculate|compute|work out|what is|how much is|percent|percentage|plus|minus|times|divided by|multiply|subtract|add)\b.*\d|\d\s*[+\-*\/%]\s*\d|(?:احسب|كام في المية|نسبة|ضرب|قسمة|جمع|طرح)/i;
const RESEARCH_RE = /\b(?:search|research|look up|find out|investigate|sources?|deep dive|explain with evidence)\b|(?:ابحث|دور على|مصادر|حقق|بحث)/i;
const SOCIAL_RE = /^(?:hi|hello|hey|thanks|thank you|good morning|good evening|how are you|اهلا|أهلا|هاي|السلام عليكم|صباح الخير|مساء الخير|شكرا|شكرًا)[!?. ]*$/i;

function normalize(value) {
  return String(value || "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 1_000);
}

function extractQuery(text) {
  return normalize(text).replace(/^(?:please\s+)?(?:search|research|look up|find out|ابحث|دور على)\s*/i, "").trim() || normalize(text);
}

function extractExpression(text) {
  const match = normalize(text).match(/[-+*/%()\d.\s]{3,}/);
  return match?.[0]?.trim() || normalize(text);
}

export function classifyFinalizedVoiceTurn({ text = "", mood = "neutral", mode = "Active Listen" } = {}) {
  const normalized = normalize(text);
  const responsePlan = selectVoiceResponsePlan({ lastUserTranscript: normalized, mood, mode });
  if (!normalized || SOCIAL_RE.test(normalized)) {
    return Object.freeze({ kind: "conversation", responsePlan, operation: null });
  }
  if (isVoiceLocalTimeRequest(normalized)) {
    return Object.freeze({ kind: "local-time", responsePlan, operation: { tool: "current_time", args: {}, cueKind: null, expectedLatencyMs: 40, strictEvidence: false } });
  }
  if (requiresVerifiedVoiceEvidence(normalized)) {
    return Object.freeze({ kind: "current-fact", responsePlan, operation: { evidenceQuery: normalized, cueKind: "checking", expectedLatencyMs: 1_800, strictEvidence: true } });
  }
  if (MEMORY_RE.test(normalized)) {
    return Object.freeze({ kind: "memory", responsePlan, operation: { tool: "search_memory", args: { query: normalized }, cueKind: "remembering", expectedLatencyMs: 900, strictEvidence: false } });
  }
  if (CALC_RE.test(normalized)) {
    return Object.freeze({ kind: "calculation", responsePlan, operation: { tool: "calculate_expression", args: { expression: extractExpression(normalized) }, cueKind: "calculating", expectedLatencyMs: 700, strictEvidence: false } });
  }
  if (RESEARCH_RE.test(normalized)) {
    return Object.freeze({ kind: "research", responsePlan, operation: { tool: "web_search", args: { query: extractQuery(normalized) }, cueKind: "checking-details", expectedLatencyMs: 1_800, strictEvidence: true } });
  }
  return Object.freeze({ kind: "conversation", responsePlan, operation: null });
}

export function buildOperationIdentity({ sessionGeneration, turnId, operationId } = {}) {
  return Object.freeze({ sessionGeneration, turnId, operationId });
}
