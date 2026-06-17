// Test script for chat_helpers parser
// Run with: node scratch/test_parser.mjs

// Inline the parser functions for testing (can't import ES modules easily)

function parseAgentChainResponse(text) {
  let clean = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!clean) return null;

  // Strip leading "Self:" prefix
  clean = clean.replace(/^\s*Self\s*:\s*/i, "").trim();

  const thoughtMatch = clean.match(
    /^\s*\*{0,2}\s*Thought\s*:?\s*\*{0,2}\s*/i
  );
  if (!thoughtMatch) return null;

  const responseDelimiters = [
    /\n\s*\*{2}\s*Balanced\s+Reframe\s*:?\s*\*{2}\s*/i,
    /\n\s*\*{2}\s*Response\s*:?\s*\*{2}\s*/i,
    /\n\s*Balanced\s+Reframe\s*:\s*/i,
    /\n\s*Response\s*:\s*/i,
  ];

  let splitIndex = -1;
  let matchLength = 0;

  for (const regex of responseDelimiters) {
    const m = clean.match(regex);
    if (m && m.index !== undefined) {
      if (splitIndex === -1 || m.index < splitIndex) {
        splitIndex = m.index;
        matchLength = m[0].length;
      }
    }
  }

  if (splitIndex === -1) {
    return {
      thoughtContent: clean.slice(thoughtMatch[0].length).trim(),
      visibleContent: "",
    };
  }

  const thoughtContent = clean.slice(thoughtMatch[0].length, splitIndex).trim();
  let visibleContent = clean.slice(splitIndex + matchLength).trim();

  visibleContent = visibleContent
    .replace(/^\s*Self\s*:\s*/i, "")
    .replace(/^\s*REVIEW\s*:\s*/i, "")
    .replace(/^\s*SELF[- ]?REVIEW\s*:\s*/i, "")
    .trim();

  return { thoughtContent, visibleContent };
}

// Test cases
const tests = [
  {
    name: "Normal Pro response with Balanced Reframe",
    input: `**Thought:** 1. INTAKE: User is asking about relationships
2. MEMORY SCAN: No prior context
3. PLAN: Validate and explore

**Balanced Reframe:** أنا فاهم إنك بتحس بضغط كبير دلوقتي...`,
    expectThought: true,
    expectVisible: true,
  },
  {
    name: "Normal Standard response with Response",
    input: `**Thought:** User wants advice about stress
1. UNDERSTAND: They feel overwhelmed
2. CONTEXT: No prior data
3. PLAN: Ground them

**Response:** I hear you — let's take a step back and look at this together.`,
    expectThought: true,
    expectVisible: true,
  },
  {
    name: "Self: REVIEW: leaked in visible content",
    input: `**Thought:** 1. INTAKE: Arabic message about relationship issue

**Balanced Reframe:** Self: REVIEW: Before proceeding, I want to ensure my response is tailored.`,
    expectThought: true,
    expectVisible: true,
  },
  {
    name: "No response delimiter — everything in thought block",
    input: `**Thought:** 1. INTAKE: The user is expressing frustration
2. MEMORY SCAN: Checking context
3. PATTERN ANALYSIS: Anxiety pattern
4. NERVOUS SYSTEM READ: Sympathetic activation
5. INTERVENTION PLAN: Validation first
6. QUALITY CHECK: Response looks good

Self: REVIEW: Before proceeding, I want to ensure that my response is tailored to your specific needs and that I'm not rushing to provide solutions.

أنا فاهم إنك بتحس بضغط كبير دلوقتي. اللي بتوصفه ده طبيعي جداً...`,
    expectThought: true,
    expectVisible: false,  // No delimiter — visibleContent will be empty
  },
  {
    name: "Self: before Thought",
    input: `Self: **Thought:** Quick reasoning here

**Response:** Here's my actual response.`,
    expectThought: true,
    expectVisible: true,
  },
  {
    name: "No Thought at all — plain text",
    input: `أنا فاهم إنك بتحس بضغط. خلينا نتكلم عن ده.`,
    expectThought: false,
    expectVisible: false,
  },
];

console.log("=== Parser Test Results ===\n");

for (const t of tests) {
  const result = parseAgentChainResponse(t.input);
  const hasThought = result && result.thoughtContent;
  const hasVisible = result && result.visibleContent;

  const thoughtOK = !!hasThought === t.expectThought;
  const visibleOK = !!hasVisible === t.expectVisible;
  const passed = thoughtOK && visibleOK;

  console.log(`${passed ? "✅" : "❌"} ${t.name}`);
  if (result) {
    console.log(`   thoughtContent: "${(result.thoughtContent || "").substring(0, 80)}..."`);
    console.log(`   visibleContent: "${(result.visibleContent || "").substring(0, 80)}..."`);
  } else {
    console.log(`   result: null (no agent chain detected)`);
  }
  if (!passed) {
    console.log(`   EXPECTED: thought=${t.expectThought}, visible=${t.expectVisible}`);
    console.log(`   GOT:      thought=${!!hasThought}, visible=${!!hasVisible}`);
  }
  console.log();
}

// Test the fallback in buildAgentChainResult
console.log("=== Fallback Test (no delimiter) ===\n");
const noDelimiterInput = `**Thought:** 1. INTAKE: User expressing frustration about Fadi

Self: REVIEW: Before proceeding, I want to ensure my response is tailored.

أنا فاهم إنك بتحس بضغط كبير. فادي بيكرهك مش معناه إنك وحش.`;

const parsed = parseAgentChainResponse(noDelimiterInput);
console.log("Parsed result:", JSON.stringify(parsed, null, 2));

if (parsed && !parsed.visibleContent) {
  console.log("\n→ visibleContent is EMPTY — fallback should kick in");
  console.log("→ thoughtContent (would be used as fallback):");
  let fallback = (parsed.thoughtContent || "").trim();
  fallback = fallback
    .replace(/^\s*Self\s*:\s*/i, "")
    .replace(/^\s*REVIEW\s*:\s*/i, "")
    .replace(/^\s*SELF[- ]?REVIEW\s*:\s*/i, "")
    .trim();
  console.log(`   "${fallback.substring(0, 200)}"`);
  console.log(`   Length: ${fallback.length} chars`);
}
