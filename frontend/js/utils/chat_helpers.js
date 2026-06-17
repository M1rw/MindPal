import { formatMarkdown } from "./dom.js";
import { escapeHtml } from "../ui_state.js?v=20260615-streaming-v7";
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

export function cognitiveSectionKey(label) {
  const normalized = String(label || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  switch (normalized) {
    case "thought":
    case "core thought":
      return "thought";
    case "distortion":
    case "distortion detected":
      return "distortion";
    case "evidence for":
      return "evidenceFor";
    case "evidence against":
      return "evidenceAgainst";
    case "reframe":
    case "balanced reframe":
      return "reframe";
    case "action":
    case "next action":
    case "next tiny action":
      return "action";
    default:
      return "unknown";
  }
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
  if (!thoughtMatch) return null;

  // Find the response delimiter — try multiple formats
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
    // No response delimiter found — the whole thing after **Thought:** is the thought
    // This can happen during streaming before the response section arrives
    return {
      thoughtContent: clean.slice(thoughtMatch[0].length).trim(),
      visibleContent: "",
    };
  }

  const thoughtContent = clean.slice(thoughtMatch[0].length, splitIndex).trim();
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
  // First, try the agent chain format: **Thought:** ... **Response:**/**Balanced Reframe:**
  const agentChain = parseAgentChainResponse(text);
  if (agentChain && agentChain.thoughtContent) {
    return buildAgentChainResult(agentChain, elapsedMs, text);
  }

  // Fall back to cognitive sections parser (Thought/Distortion/Evidence/Reframe/Action)
  const sections = parseCognitiveSections(text);

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
      finalHtml: formatMarkdown(text),
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

  let finalHtml = `<div class="text-[15px] leading-relaxed mb-4">${formatMarkdown(visibleBody)}</div>`;

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

  // If we have no visible content yet (still streaming thought block),
  // show empty content — the status indicator above handles "Thinking…"
  if (!visibleContent) {
    return {
      timelineHtml: "",
      finalHtml: "",
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

  const finalHtml = `<div class="text-[15px] leading-relaxed mb-4">${formatMarkdown(visibleContent)}</div>`;

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
