// Test the exact scenario from the screenshot
function buildFallback(thoughtContent, rawText) {
  let fallbackContent = (thoughtContent || rawText || "").trim();

  const lastStepPatterns = [
    /(?:^|\n)\s*6[\.\)]\s*(?:QUALITY\s*CHECK|SELF[- ]?REVIEW|REVIEW)\s*:[^\n]*(?:\n)([\s\S]*)/i,
    /6[\.\)]\s*(?:QUALITY\s*CHECK|SELF[- ]?REVIEW|REVIEW)\s*:[^.]*\.\s*([\s\S]*)/i,
    /(?:^|\n)\s*5[\.\)]\s*[A-Z][A-Z\s]*:[^\n]*(?:\n)([\s\S]*)/i,
    /5[\.\)]\s*(?:INTERVENTION\s*PLAN|PLAN)\s*:[^.]*\.\s*([\s\S]*)/i,
  ];

  let extracted = false;
  for (const pattern of lastStepPatterns) {
    const m = fallbackContent.match(pattern);
    if (m && m[1].trim().length > 20) {
      fallbackContent = m[1].trim();
      extracted = true;
      break;
    }
  }

  if (!extracted) {
    fallbackContent = fallbackContent
      .replace(/[1-6][\.\)]\s*(?:INTAKE|MEMORY\s*SCAN|PATTERN\s*ANALYSIS|NERVOUS\s*SYSTEM\s*READ|INTERVENTION\s*PLAN|QUALITY\s*CHECK|SELF[- ]?REVIEW|REVIEW|CONTEXT|PLAN)\s*:/gi, "")
      .trim();
  }

  fallbackContent = fallbackContent
    .replace(/^\s*Self\s*:\s*/i, "")
    .replace(/^\s*REVIEW\s*:\s*/i, "")
    .replace(/^\s*SELF[- ]?REVIEW\s*:\s*/i, "")
    .replace(/^\s*Before\s+proceeding[^.]*\.\s*/i, "")
    .trim();

  if (/^\s*[1-6][\.\)]/.test(fallbackContent)) {
    fallbackContent = fallbackContent
      .replace(/(?:^|\n)\s*[1-6][\.\)]\s*[A-Z][A-Z\s]*:[^\n]*/gi, "")
      .trim();
  }

  return fallbackContent;
}

// Test 1: No spaces, no newlines (exact screenshot scenario)
const noSpaces = `1.INTAKE:You'reexpressingfeelingsofrejectiona` +
  `ndabandonmentbyFadi,whichisexacerbatingyouremotionaldistress.2.M` +
  `EMORYSCAN:Checkingcontext.3.PATTERNANALYSIS:Anxietypattern.4.NERVOUSSYSTEMREAD:Isense` +
  `thatyournervousystemishighlyactivated.5.INTERVENTIONPLAN:Validationfirst.6.SELF-` +
  `REVIEW:Beforeproceeding,Iwanttoensure` +
  `thatmyresponseistailoredtoyourspecificneedsandthatI'mnotrushingtoprovidesolutions.` +
  `Whataresomethingsthatyou'reproudofaccomplishing?` +
  `Remember,yourworthandvaluecomefromwithin.Youdon'tneedanyoneelse'svalidationtofeelgoodaboutyourself.`;

console.log("=== Test 1: No spaces, no newlines ===");
const result1 = buildFallback(noSpaces, noSpaces);
console.log("Result:", JSON.stringify(result1.substring(0, 200)));
console.log("Length:", result1.length);
console.log("Has content:", result1.length > 0 ? "✅" : "❌");

// Test 2: Normal with newlines 
const normal = `1. INTAKE: User expressing feelings of rejection
2. MEMORY SCAN: Checking context
3. PATTERN ANALYSIS: Anxiety pattern
4. NERVOUS SYSTEM READ: Sympathetic activation
5. INTERVENTION PLAN: Validation first
6. QUALITY CHECK: Response looks tailored

أنا فاهم إنك بتحس بضغط كبير. فادي بيكرهك مش معناه إنك وحش.`;

console.log("\n=== Test 2: Normal with newlines ===");
const result2 = buildFallback(normal, normal);
console.log("Result:", JSON.stringify(result2.substring(0, 200)));
console.log("Has Arabic:", /[\u0600-\u06FF]/.test(result2) ? "✅" : "❌");

// Test 3: With Self: REVIEW: prefix after step 6
const withSelfReview = `1. INTAKE: Test
2. MEMORY SCAN: Test
3. PATTERN ANALYSIS: Test
4. NERVOUS SYSTEM READ: Test
5. INTERVENTION PLAN: Test
6. QUALITY CHECK: Checking quality

Self: REVIEW: Before proceeding, let me verify.

أنا فاهم إنك بتمر بوقت صعب وبتحس إن حد بيكرهك.`;

console.log("\n=== Test 3: Self: REVIEW: after step 6 ===");
const result3 = buildFallback(withSelfReview, withSelfReview);
console.log("Result:", JSON.stringify(result3.substring(0, 200)));
console.log("Has Arabic:", /[\u0600-\u06FF]/.test(result3) ? "✅" : "❌");
console.log("No REVIEW:", !result3.includes("REVIEW") ? "✅" : "❌");
