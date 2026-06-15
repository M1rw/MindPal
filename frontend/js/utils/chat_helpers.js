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

export function processStructuredResponse(text, elapsedMs = null) {
  const sections = parseCognitiveSections(text);
  
  // Looser check: if ANY cognitive section was found, we treat it as structured
  const hasCognitiveStructure = Boolean(
    sections.thought || 
    sections.distortion || 
    sections.evidenceFor || 
    sections.evidenceAgainst || 
    sections.reframe || 
    sections.action
  );

  if (!hasCognitiveStructure) {
    return {
      timelineHtml: "",
      finalHtml: formatMarkdown(text),
    };
  }

  const thought = sections.thought;
  const distortion = sections.distortion;
  const evidenceFor = sections.evidenceFor;
  const evidenceAgainst = sections.evidenceAgainst;
  const reframe = sections.reframe || sections.preamble;
  const action = sections.action;

  const timeText = elapsedMs 
    ? `Thought for ${(elapsedMs / 1000).toFixed(1)}s`
    : "Thought for a few seconds";

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

  let finalHtml = `<div class="text-[15px] leading-relaxed mb-4">${formatMarkdown(reframe)}</div>`;

  if (action) {
    finalHtml += `<div class="mt-4"><strong class="text-gray-900 dark:text-white font-semibold">Next Action:</strong> ${formatMarkdown(action)}</div>`;
  }

  return { timelineHtml, finalHtml };
}
