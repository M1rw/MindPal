import { formatMarkdown } from "./dom.js";
import { escapeHtml } from "../ui_state.js";

/**
 * Detect and truncate LLM repetition loops.
 * Splits text on sentence boundaries and allows each unique sentence at most
 * twice. This catches the common LLM failure mode of repeating the same
 * phrase dozens of times (especially in Arabic/RTL text).
 */
export function truncateRepetition(text) {
  if (!text || text.length < 80) return text;

  // Split on sentence-ending punctuation (., ?, !, ؟) while keeping the delimiter
  const sentences = text.split(/(?<=[.\n\u061F?!])\s*/);
  if (sentences.length < 4) return text;

  const seen = new Map();
  const out = [];

  for (const sentence of sentences) {
    const key = sentence.trim().toLowerCase();
    if (!key) { out.push(sentence); continue; }

    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);

    // Allow up to 2 occurrences, drop the rest
    if (count <= 2) {
      out.push(sentence);
    }
  }

  return out.join(" ");
}

export function timelineItem(title, body, icon, bodyIsHtml = false) {
  return `
    <div class="relative">
      <div class="absolute -left-[33px] top-0 bg-gemini-bg dark:bg-gemini-darkBg py-1">
        <i data-lucide="${icon}" class="w-4 h-4 text-gray-400 dark:text-[#c4c7c5]"></i>
      </div>
      <div class="leading-relaxed">
        <strong class="text-gray-900 dark:text-white font-semibold">${escapeHtml(title)}${body ? ":" : ""}</strong>
        ${body ? (bodyIsHtml ? body : formatMarkdown(body)) : ""}
      </div>
    </div>
  `;
}

export function parseCognitiveSections(text) {
  const sections = {
    thought: "",
    distortion: "",
    evidenceFor: "",
    evidenceAgainst: "",
    reframe: "",
    action: "",
    preamble: "",
  };

  const clean = String(text || "").replace(/\r\n/g, "\n").trim();

  if (!clean) return sections;

  const labelToKey = {
    thought: "thought",
    "core thought": "thought",
    distortion: "distortion",
    "distortion detected": "distortion",
    "evidence for": "evidenceFor",
    "evidence against": "evidenceAgainst",
    "balanced reframe": "reframe",
    "next tiny action": "action",
    "next action": "action",
  };

  const labelPattern = [
    "Balanced Reframe",
    "Evidence Against",
    "Evidence For",
    "Next Tiny Action",
    "Distortion Detected",
    "Core Thought",
    "Next Action",
    "Distortion",
    "Thought",
  ].join("|");

  const headingRegex = new RegExp(
    `^\\s*(?:[-*]\\s*)?(?:\\*\\*)?\\s*(${labelPattern})(?=\\s|:|\\*|$)\\s*(?::\\s*)?(?:\\*\\*)?\\s*`,
    "gim",
  );

  const matches = [];
  let match;

  while ((match = headingRegex.exec(clean)) !== null) {
    const label = String(match[1] || "").toLowerCase();
    const key = labelToKey[label];

    if (!key) continue;

    matches.push({
      key,
      index: match.index,
      contentStart: headingRegex.lastIndex,
    });
  }

  matches.sort((a, b) => a.index - b.index);

  if (matches.length > 0 && matches[0].index > 0) {
    sections.preamble = clean.slice(0, matches[0].index).trim();
  }

  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];

    const value = clean
      .slice(current.contentStart, next ? next.index : clean.length)
      .trim();

    if (value && !sections[current.key]) {
      sections[current.key] = value;
    }
  }

  return sections;
}

/**
 * Parse agent chain output format:
 *   **Thought:** [internal reasoning]
 *   **Response:** or **Balanced Reframe:** [visible content]
 *
 * Returns { thoughtContent, visibleContent } or null if no pattern found.
 */
function parseAgentChainResponse(text) {
  let clean = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!clean) return null;

  // Strip leading "Self:" prefix the LLM sometimes adds before **Thought:**
  clean = clean.replace(/^\s*Self\s*:\s*/i, "").trim();

  // Match **Thought:** ... followed by **Response:** or **Balanced Reframe:**
  const thoughtMatch = clean.match(
    /^\s*\*{0,2}\s*Thought\s*:?\s*\*{0,2}\s*/i
  );


  // Find the response delimiter — try multiple formats
  // Uses \s* (not \s+) so it matches both "Balanced Reframe" and "BalancedReframe"
  const responseDelimiters = [
    /\n\s*\*{2}\s*Balanced\s*Reframe\s*:?\s*\*{2}\s*/i,
    /\n\s*\*{2}\s*Response\s*:?\s*\*{2}\s*/i,
    /\n\s*Balanced\s*Reframe\s*:\s*/i,
    /\n\s*Response\s*:\s*/i,
    // Also match inline without newline (when entire output is one line or no newline was generated)
    /\*{2}\s*Balanced\s*Reframe\s*:?\s*\*{2}\s*/i,
    /\*{2}\s*Response\s*:?\s*\*{2}\s*/i,
    /\s+Response\s*:\s*/i,
    /\s+Balanced\s*Reframe\s*:\s*/i,
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
    // No response delimiter found
    if (!thoughtMatch) return null; // If neither thought nor response delimiter is found, it's not a chain

    // This can happen during streaming before the response section arrives
    return {
      thoughtContent: clean.slice(thoughtMatch[0].length).trim(),
      visibleContent: "",
    };
  }

  const thoughtStart = thoughtMatch ? thoughtMatch[0].length : 0;
  const thoughtContent = clean.slice(thoughtStart, splitIndex).trim();
  let visibleContent = clean.slice(splitIndex + matchLength).trim();

  // Strip leaked internal reasoning prefixes from the visible response
  // e.g. "Self: REVIEW: Before proceeding..." or "REVIEW: I want to ensure..."
  visibleContent = visibleContent
    .replace(/^\s*Self\s*:\s*/i, "")
    .replace(/^\s*REVIEW\s*:\s*/i, "")
    .replace(/^\s*SELF[- ]?REVIEW\s*:\s*/i, "")
    .trim();

  return { thoughtContent, visibleContent };
}

export function processStructuredResponse(text, elapsedMs = null) {
  // Truncate any LLM repetition loops before processing
  const cleanText = truncateRepetition(text) || text;

  // First, try the agent chain format: **Thought:** ... **Response:**/**Balanced Reframe:**
  const agentChain = parseAgentChainResponse(cleanText);
  if (agentChain && agentChain.thoughtContent) {
    return buildAgentChainResult(agentChain, elapsedMs, cleanText);
  }

  // Fall back to cognitive sections parser (Thought/Distortion/Evidence/Reframe/Action)
  const sections = parseCognitiveSections(cleanText);

  // Only build a timeline dropdown if we actually have thinking logic to show
  const hasTimelineItems = Boolean(
    sections.thought ||
    sections.distortion ||
    sections.evidenceFor ||
    sections.evidenceAgainst
  );

  if (!hasTimelineItems) {
    return {
      timelineHtml: "",
      finalHtml: formatMarkdown(cleanText),
    };
  }

  const thought = sections.thought;
  const distortion = sections.distortion;
  const evidenceFor = sections.evidenceFor;
  const evidenceAgainst = sections.evidenceAgainst;
  const reframe = sections.reframe || sections.preamble || "";
  const action = sections.action;

  const timeText = elapsedMs
    ? `Thought for ${(elapsedMs / 1000).toFixed(1)}s`
    : "Thinking\u2026";

  const timelineHtml = `
    <div class="thought-accordion group mb-5">
      <div class="accordion-header flex items-center gap-2 cursor-pointer text-[15px] text-[#444746] dark:text-[#c4c7c5] hover:text-gray-900 dark:hover:text-white font-medium select-none transition-colors w-fit">
        <span class="collapsed-text">${timeText}</span>
        <span class="expanded-text hidden">Analyzed cognitive patterns</span>
        <i data-lucide="chevron-right" class="w-4 h-4 transition-transform duration-300 transform chevron-icon"></i>
      </div>

      <div class="accordion-content max-h-0 opacity-0 transition-all duration-300 ease-in-out overflow-hidden">
          <div class="mt-4 ml-[7px] pl-6 border-l border-gray-200 dark:border-[#444746] space-y-5 text-[15px] text-gray-700 dark:text-gray-300 relative pb-4">
            ${thought ? timelineItem("Thought", thought, "circle-minus") : ""}
            ${distortion ? timelineItem("Distortion", distortion, "circle-minus") : ""}
            ${evidenceFor ? timelineItem("Evidence For", evidenceFor, "circle-minus") : ""}
            ${evidenceAgainst ? timelineItem("Evidence Against", evidenceAgainst, "circle-minus") : ""}
            ${timelineItem("Done", "", "check-circle-2")}
          </div>
      </div>
    </div>
  `;

  // Build the visible response body — fall back if reframe is empty
  const visibleBody = reframe
    || action
    || "I've reflected on what you shared. Would you like to talk more about it?";

  let finalHtml = `<div class="text-[15px] leading-relaxed" dir="auto">${formatMarkdown(visibleBody)}</div>`;

  if (action && reframe) {
    finalHtml += `<div class="mt-4"><strong class="text-gray-900 dark:text-white font-semibold">Next Action:</strong> ${formatMarkdown(action)}</div>`;
  }

  return { timelineHtml, finalHtml };
}

/**
 * Build the timeline accordion + visible response from agent chain format.
 */
function buildAgentChainResult(agentChain, elapsedMs, rawText) {
  const { thoughtContent, visibleContent } = agentChain;

  // If we have no visible content yet:
  // - During streaming (no elapsedMs): show empty — "Thinking…" indicator handles it
  // - After streaming is done (elapsedMs set): the LLM never wrote a response delimiter,
  //   so extract the actual response from the thought content
  if (!visibleContent) {
    if (!elapsedMs) {
      return {
        timelineHtml: "",
        finalHtml: "",
      };
    }

    // Fallback: extract the actual response from the thought block
    let fallbackContent = (thoughtContent || rawText || "").trim();

    // Strategy 1: Try to find content after the last numbered clinical step
    // Works for both newline-separated and single-line outputs
    // Matches: "6. QUALITY CHECK: ...", "6.SELF-REVIEW:...", etc.
    const lastStepPatterns = [
      // With newlines
      /(?:^|\n)\s*6[\.\)]\s*(?:QUALITY\s*CHECK|SELF[- ]?REVIEW|REVIEW)\s*:[^\n]*(?:\n)([\s\S]*)/i,
      // Without newlines (inline) — match step 6 and grab everything after the step content
      /6[\.\)]\s*(?:QUALITY\s*CHECK|SELF[- ]?REVIEW|REVIEW)\s*:[^.]*\.\s*([\s\S]*)/i,
      // Match step 5 (INTERVENTION PLAN) and grab everything after
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

    // Strategy 2: If no step was matched, strip ALL numbered step patterns
    if (!extracted) {
      // Remove step markers like "1.INTAKE:", "2.MEMORY SCAN:", etc.
      // Handles both "1. INTAKE:" (with space) and "1.INTAKE:" (no space)
      fallbackContent = fallbackContent
        .replace(/[1-6][\.\)]\s*(?:INTAKE|MEMORY\s*SCAN|PATTERN\s*ANALYSIS|NERVOUS\s*SYSTEM\s*READ|INTERVENTION\s*PLAN|QUALITY\s*CHECK|SELF[- ]?REVIEW|REVIEW|CONTEXT|PLAN)\s*:/gi, "")
        .trim();
    }

    // Strip leaked prefixes
    fallbackContent = fallbackContent
      .replace(/^\s*Self\s*:\s*/i, "")
      .replace(/^\s*REVIEW\s*:\s*/i, "")
      .replace(/^\s*SELF[- ]?REVIEW\s*:\s*/i, "")
      .replace(/^\s*Before\s+proceeding[^.]*\.\s*/i, "")
      .trim();

    // If still looks like step content (starts with a number), strip all steps
    if (/^\s*[1-6][\.\)]/.test(fallbackContent)) {
      fallbackContent = fallbackContent
        .replace(/(?:^|\n)\s*[1-6][\.\)]\s*[A-Z][A-Z\s]*:[^\n]*/gi, "")
        .trim();
    }

    return {
      timelineHtml: "",
      finalHtml: fallbackContent
        ? `<div class="text-[15px] leading-relaxed" dir="auto">${formatMarkdown(fallbackContent)}</div>`
        : "",
    };
  }

  const timeText = elapsedMs
    ? `Thought for ${(elapsedMs / 1000).toFixed(1)}s`
    : "Thinking\u2026";

  // Parse thought content into numbered steps for a nice timeline
  const steps = parseThoughtSteps(thoughtContent);

  let timelineItems = "";
  if (steps.length > 0) {
    timelineItems = steps
      .map((step) => timelineItem(step.label, step.content, "circle-minus"))
      .join("");
  } else {
    // Fallback: show the entire thought as a single block
    timelineItems = timelineItem("Thought", thoughtContent, "circle-minus");
  }
  timelineItems += timelineItem("Done", "", "check-circle-2");

  const timelineHtml = `
    <div class="thought-accordion group mb-5">
      <div class="accordion-header flex items-center gap-2 cursor-pointer text-[15px] text-[#444746] dark:text-[#c4c7c5] hover:text-gray-900 dark:hover:text-white font-medium select-none transition-colors w-fit">
        <span class="collapsed-text">${timeText}</span>
        <span class="expanded-text hidden">Analyzed cognitive patterns</span>
        <i data-lucide="chevron-right" class="w-4 h-4 transition-transform duration-300 transform chevron-icon"></i>
      </div>

      <div class="accordion-content max-h-0 opacity-0 transition-all duration-300 ease-in-out overflow-hidden">
          <div class="mt-4 ml-[7px] pl-6 border-l border-gray-200 dark:border-[#444746] space-y-5 text-[15px] text-gray-700 dark:text-gray-300 relative pb-4">
            ${timelineItems}
          </div>
      </div>
    </div>
  `;

  const finalHtml = `<div class="text-[15px] leading-relaxed" dir="auto">${formatMarkdown(visibleContent)}</div>`;

  return { timelineHtml, finalHtml };
}

/**
 * Parse numbered thought steps like:
 *   1. INTAKE: ...
 *   2. MEMORY SCAN: ...
 * into [{label, content}]
 */
function parseThoughtSteps(text) {
  const clean = String(text || "").trim();
  if (!clean) return [];

  // Match numbered steps: "1. LABEL: content" or "1. LABEL — content"
  const stepRegex = /(?:^|\n)\s*(\d+)\.\s*([A-Z][A-Z\s]+?)(?::|—|–|-)\s*/g;
  const steps = [];
  let match;
  const matchPositions = [];

  while ((match = stepRegex.exec(clean)) !== null) {
    matchPositions.push({
      label: match[2].trim(),
      contentStart: stepRegex.lastIndex,
      index: match.index,
    });
  }

  for (let i = 0; i < matchPositions.length; i++) {
    const current = matchPositions[i];
    const next = matchPositions[i + 1];
    const content = clean
      .slice(current.contentStart, next ? next.index : clean.length)
      .trim();

    // Clean up the label to title case
    const label = current.label
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());

    steps.push({ label, content });
  }

  return steps;
}
