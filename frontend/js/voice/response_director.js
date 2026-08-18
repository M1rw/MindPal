// Pure, deterministic response planning for Voice prompts. It chooses a response
// shape, never user-facing wording, so the model can stay natural and language-matched.

function normalize(value) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
}

const SOCIAL_RE = /^(?:hi|hello|hey|thanks|thank you|good morning|good evening|how are you|اهلا|أهلا|هاي|السلام عليكم|صباح الخير|مساء الخير|شكرا|شكرًا)[!?. ]*$/i;
const CURRENT_FACT_RE = /\b(?:current|latest|today(?:'s)?|right now|news|breaking|weather|score|mayor|president|minister|election)\b|(?:أخبار|خبر|الآن|حاليًا|اليوم|الطقس|عمدة|رئيس|وزير)/i;
const MARKET_PRICE_RE = /\b(?:price|cost)\s+(?:of|for)\s+(?:gold|silver|bitcoin|btc|dollar|usd|euro|oil|gas|stock|shares?)\b|\b(?:how much is)\s+(?:gold|silver|bitcoin|btc|dollar|usd|euro|oil|gas)\b|(?:سعر\s+(?:الذهب|الفضة|الدولار|اليورو|البنزين|البيتكوين))/i;
const PRACTICAL_RE = /\b(?:money|business|client|customer|sell|sales|offer|skill|job|career|college|university|study|build|project|plan|discipline|focus)\b|(?:فلوس|بيزنس|عميل|شغل|مهارة|جامعة|مشروع|خطة|تركيز)/i;
const PERSONAL_RE = /\b(?:feel|feeling|overwhelmed|stuck|lost|afraid|scared|anxious|sad|hurt|alone|don't know|do not know|confused|relationship|girls|party)\b|(?:حاسس|شعور|مضغوط|تايه|خايف|قلقان|زعلان|لوحدي|مش عارف|مش عارفة)/i;
const DIRECT_QUESTION_RE = /(?:\?|\b(?:what|why|how|when|where|which|who|can you|should i|is it)\b|(?:إيه|ايه|ليه|ازاي|إزاي|امتى|فين|مين|هل|ممكن))/i;

export function selectVoiceResponsePlan({ lastUserTranscript = "", mood = "neutral", mode = "Active Listen" } = {}) {
  const text = normalize(lastUserTranscript);
  const words = text ? text.split(" ").filter(Boolean).length : 0;
  const shared = {
    language: "Use the user's current spoken language or natural code-switching; do not translate unless asked.",
    naturalness: "Do not announce a template, label emotions, or force an opening acknowledgement. Vary the first beat. Never let generic empathy replace the useful part.",
  };

  if (!text) {
    return {
      id: "opening",
      ...shared,
      instruction: "Give one warm, unforced sentence. Invite the user in without a stock question or a speech about what you can do.",
      sentenceBudget: "1 sentence",
    };
  }

  if (CURRENT_FACT_RE.test(text) || MARKET_PRICE_RE.test(text)) {
    return {
      id: "verified_fact",
      ...shared,
      instruction: "Do not guess. If verification is pending, say one brief, natural wait phrase only after the user yields. When trusted evidence arrives, answer the question directly first, then add one compact context sentence only if useful.",
      sentenceBudget: "1 short bridge or 1–2 answer sentences",
    };
  }

  if (SOCIAL_RE.test(text)) {
    return {
      id: "social",
      ...shared,
      instruction: "Reply like a person in a real conversation: one light, specific sentence. Ask a question only if it creates momentum; never manufacture depth from a greeting.",
      sentenceBudget: "1 sentence, optionally 1 short question",
    };
  }

  if (PRACTICAL_RE.test(text) && (PERSONAL_RE.test(text) || words >= 16)) {
    return {
      id: "practical_conflict",
      ...shared,
      instruction: "Find the actual bottleneck or trade-off. Name it concretely, take a useful stance, and give one next move that can be done this week. Do not give a checklist, generic motivation, or a question before contributing something real.",
      sentenceBudget: "2–3 compact sentences",
    };
  }

  if (PERSONAL_RE.test(text) || mood === "supportive" || mood === "grounded") {
    return {
      id: "reflective_support",
      ...shared,
      instruction: "Show you understood one specific tension, not merely that the user feels bad. Then offer one clear reframing, distinction, or grounded move. A question is optional and must be precise enough to move the conversation forward.",
      sentenceBudget: "1–3 compact sentences",
    };
  }

  if (DIRECT_QUESTION_RE.test(text)) {
    return {
      id: "direct_answer",
      ...shared,
      instruction: "Answer the actual question in the first sentence. Add context only if it changes the decision or understanding. Do not begin with validation, a disclaimer, or a broad follow-up question.",
      sentenceBudget: "1–3 compact sentences",
    };
  }

  return {
    id: "grounded_follow_on",
    ...shared,
    instruction: `Build on the exact point the user made. Give one observation, distinction, or useful continuation before asking anything. Respect the ${mode} mode without sounding like a mode label.`,
    sentenceBudget: "1–3 compact sentences",
  };
}

export function buildVoiceResponsePlanBlock(input = {}) {
  const plan = selectVoiceResponsePlan(input);
  return `VOICE RESPONSE PLAN — ${plan.id}\n- ${plan.instruction}\n- ${plan.language}\n- ${plan.naturalness}\n- Spoken budget: ${plan.sentenceBudget}`;
}
