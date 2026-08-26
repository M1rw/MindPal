import DOMPurify from "dompurify";
import { scrollChatToBottom } from "../state/ui_state.js";
export { scrollChatToBottom };

const RICH_HTML_POLICY = Object.freeze({
  ALLOWED_TAGS: [
    "a", "blockquote", "br", "code", "div", "em", "h2", "h3", "h4", "hr", "i", "img",
    "li", "ol", "p", "pre", "span", "strong", "table", "tbody", "td", "th", "thead",
    "tr", "ul", "button", "svg", "polyline", "path",
  ],
  ALLOWED_ATTR: [
    "aria-controls", "aria-expanded", "aria-hidden", "aria-label", "class", "data-lucide", "data-target",
    "alt", "dir", "fill", "height", "href", "id", "referrerpolicy", "rel", "role", "scope", "src", "stroke", "stroke-linecap",
    "stroke-linejoin", "stroke-width", "style", "tabindex", "target", "type", "viewBox", "width",
  ],
  ALLOW_DATA_ATTR: false,
  ALLOWED_URI_REGEXP: /^(?:(?:https?):|mailto:|\/(?!\/))/i,
});

const CODE_TOKEN = /@@MINDPAL_CODE_BLOCK_(\d+)@@/g;
const TOKEN_PREFIX = "@@MINDPAL_RICH_";
const TOKEN_SUFFIX = "@@";

export function sanitizeRichHtml(html) {
  return DOMPurify.sanitize(String(html || ""), RICH_HTML_POLICY);
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * Render a deliberately small, safe Markdown subset for user-facing replies.
 *
 * It is intentionally not a full Markdown engine: embedded HTML, images, task
 * lists, and arbitrary attributes are never interpreted. The renderer supports
 * the structures that make an answer easier to scan in a chat: headings, short
 * paragraphs, lists, blockquotes, comparison tables, code, emphasis, and links.
 */
export function formatMarkdown(text) {
  const codeBlocks = [];
  let source = normalizeInlineListMarkers(String(text || "").replace(/\r\n/g, "\n"));

  source = source.replace(/```([\w+-]*)\n([\s\S]*?)```/g, (_match, language, code) => {
    const safeLanguage = escapeHtml(language || "");
    const safeCode = escapeHtml(code.replace(/\n$/, ""));
    const token = `@@MINDPAL_CODE_BLOCK_${codeBlocks.length}@@`;
    codeBlocks.push(
      `<div class="code-block-wrap">${safeLanguage ? `<div class="code-lang-label">${safeLanguage}</div>` : ""}`
      + `<pre class="code-block"><code>${safeCode}</code></pre></div>`,
    );
    return token;
  });

  const lines = source.split("\n");
  const blocks = [];
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const content = paragraph.join(" ").trim();
    if (content) blocks.push(`<p class="mp-paragraph">${renderInline(content)}</p>`);
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    if (CODE_TOKEN.test(trimmed)) {
      CODE_TOKEN.lastIndex = 0;
      flushParagraph();
      blocks.push(trimmed);
      continue;
    }
    CODE_TOKEN.lastIndex = 0;

    const heading = trimmed.match(/^(#{1,3})\s+(.+?)\s*#*$/);
    if (heading) {
      flushParagraph();
      const tag = heading[1].length === 1 ? "h2" : heading[1].length === 2 ? "h3" : "h4";
      blocks.push(`<${tag} class="mp-heading mp-heading--${tag}">${renderInline(heading[2])}</${tag}>`);
      continue;
    }

    if (/^(?:---|\*\*\*|___)\s*$/.test(trimmed)) {
      flushParagraph();
      blocks.push('<hr class="mp-divider">');
      continue;
    }

    if (isTableStart(lines, index)) {
      flushParagraph();
      const { html, nextIndex } = renderTable(lines, index);
      blocks.push(html);
      index = nextIndex;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      flushParagraph();
      const quoteLines = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      index -= 1;
      blocks.push(`<blockquote class="mp-callout"><div class="mp-callout__bar"></div><p>${renderInline(quoteLines.join(" "))}</p></blockquote>`);
      continue;
    }

    if (isListLine(trimmed)) {
      flushParagraph();
      const { html, nextIndex } = renderList(lines, index);
      blocks.push(html);
      index = nextIndex;
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  let result = blocks.join("\n");
  result = result.replace(CODE_TOKEN, (_match, index) => codeBlocks[Number(index)] || "");
  return result;
}

function renderInline(value) {
  const tokens = [];
  const addToken = (html) => {
    const token = `${TOKEN_PREFIX}${tokens.length}${TOKEN_SUFFIX}`;
    tokens.push(html);
    return token;
  };

  let source = String(value || "");

  // Capture explicit Markdown links before escaping. Only http(s) and mailto links are accepted.
  source = source.replace(/\[([^\]\n]{1,180})\]\(([^)]+)\)/g, (match, label, url) => {
    const safeUrl = normalizeLink(url);
    return safeUrl ? addToken(renderSourceLink(normalizeLinkLabel(label, safeUrl), safeUrl)) : match;
  });

  // A bare web URL is still useful in chat, but gets the same safe, compact treatment.
  source = source.replace(/(^|[\s(])((?:https?:\/\/)[^\s<>()]+)/g, (match, prefix, url) => {
    const safeUrl = normalizeLink(url);
    return safeUrl ? `${prefix}${addToken(renderSourceLink(shortLinkLabel(safeUrl), safeUrl))}` : match;
  });

  source = source.replace(/`([^`\n]+?)`/g, (_match, code) => addToken(`<code class="inline-code">${escapeHtml(code)}</code>`));
  let result = escapeHtml(source);

  result = result.replace(/\*\*([^*\n][\s\S]*?)\*\*/g, '<strong class="mp-strong">$1</strong>');
  result = result.replace(/(^|[^*])\*([^*\n]+?)\*/g, "$1<em>$2</em>");
  result = result.replace(/~~([^~\n]+?)~~/g, '<span class="mp-strike">$1</span>');

  const tokenPattern = new RegExp(`${TOKEN_PREFIX}(\\d+)${TOKEN_SUFFIX}`, "g");
  result = result.replace(tokenPattern, (_match, index) => tokens[Number(index)] || "");
  return result;
}

function normalizeInlineListMarkers(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.replace(/([.!?])\s+(?=(?:[-*•]\s+|\d+[.)]\s+))/g, "$1\n"))
    .join("\n");
}

function renderList(lines, startIndex) {
  const ordered = /^\s*\d+[.)]\s+/.test(lines[startIndex]);
  const pattern = ordered ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-*•]\s+(.+)$/;
  const rawItems = [];
  let index = startIndex;

  while (index < lines.length) {
    const match = lines[index].match(pattern);
    if (!match) break;
    rawItems.push(match[1]);
    index += 1;
  }

  const items = rawItems.map((item) => `<li>${renderInline(item)}</li>`);
  const sourceOnly = !ordered && rawItems.length > 0 && rawItems.every((item) =>
    /^\s*(?:\[[^\]]+\]\([^)]+\)|https?:\/\/\S+)\s*$/.test(item),
  );
  const safetyActionList = ordered && rawItems.length > 1 && rawItems.some((item) =>
    /\b(?:move away|go near|message or call|keep your phone|put down|step into|ابعد|روح جنب|خلي موبايلك|سيب أي حاجة)\b/i.test(item),
  );
  const tag = ordered && !safetyActionList ? "ol" : "ul";
  const className = safetyActionList
    ? "mp-list mp-list--actions"
    : ordered ? "mp-list mp-list--ordered"
      : sourceOnly ? "mp-list mp-list--sources" : "mp-list mp-list--bulleted";
  return { html: `<${tag} class="${className}">${items.join("")}</${tag}>`, nextIndex: index - 1 };
}

function isListLine(line) {
  return /^\s*(?:[-*•]\s+|\d+[.)]\s+)/.test(line);
}

function isTableStart(lines, index) {
  return Boolean(
    lines[index]?.includes("|")
    && index + 1 < lines.length
    && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1]),
  );
}

function renderTable(lines, startIndex) {
  const headers = splitTableRow(lines[startIndex]);
  const rows = [];
  let index = startIndex + 2;

  while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
    const cells = splitTableRow(lines[index]);
    if (cells.length < 2) break;
    rows.push(cells);
    index += 1;
  }

  const headHtml = headers.map((cell) => `<th scope="col">${renderInline(cell)}</th>`).join("");
  const bodyHtml = rows.map((cells) => {
    const padded = headers.map((_header, cellIndex) => cells[cellIndex] || "");
    return `<tr>${padded.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`;
  }).join("");

  return {
    html: `<div class="mp-table-scroll" role="region" aria-label="Response comparison table" tabindex="0">`
      + `<table class="mp-table"><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`,
    nextIndex: index - 1,
  };
}

function splitTableRow(line) {
  return String(line || "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function normalizeLink(value) {
  const compactValue = String(value || "").trim().replace(/\s+/g, "");
  try {
    const url = new URL(compactValue);
    if (!(["https:", "http:", "mailto:"].includes(url.protocol))) return "";
    return url.href;
  } catch {
    return "";
  }
}

function normalizeLinkLabel(label, url) {
  const visibleLabel = String(label || "").replace(/\s+/g, " ").trim();
  const compactLabel = visibleLabel.replace(/\s+/g, "");
  return /^(?:https?:\/\/|www\.)/i.test(compactLabel)
    ? shortLinkLabel(url)
    : visibleLabel || shortLinkLabel(url);
}

function shortLinkLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || "Open source";
  } catch {
    return "Open source";
  }
}

function renderSourceLink(label, url) {
  const fallbackIcon = '<svg class="mp-source-link__icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>';
  const favicon = faviconForUrl(url);
  const icon = favicon
    ? `<img class="mp-source-link__favicon" src="${escapeHtml(favicon)}" alt="" aria-hidden="true" referrerpolicy="no-referrer">`
    : fallbackIcon;
  return `<a class="mp-source-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${icon}<span>${escapeHtml(label)}</span></a>`;
}

function faviconForUrl(url) {
  try {
    const parsed = new URL(url);
    if (!(["https:", "http:"].includes(parsed.protocol))) return "";
    return `/api/favicon?v=2&url=${encodeURIComponent(parsed.href)}`;
  } catch {
    return "";
  }
}

export function stripMarkdown(text) {
  return String(text || "")
    .replace(/```[\w+-]*\n?([\s\S]*?)```/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`\n]+?)`/g, "$1")
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "")
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, "")
    .replace(/\|/g, " ")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function typewriteHTML(element, html, scrollContainer) {
  const template = document.createElement("template");
  template.innerHTML = sanitizeRichHtml(html);

  const fragment = template.content.cloneNode(true);
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node = walker.nextNode();
  while (node) {
    const fullText = node.textContent || "";
    node.textContent = "";
    textNodes.push({ node, fullText });
    node = walker.nextNode();
  }

  element.replaceChildren(fragment);
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  if (reduceMotion) {
    for (const item of textNodes) item.node.textContent = item.fullText;
    scrollChatToBottom("auto", true);
    return;
  }

  const charsPerFrame = 6;
  let frame = 0;
  for (const item of textNodes) {
    for (let offset = 0; offset < item.fullText.length; offset += charsPerFrame) {
      item.node.textContent += item.fullText.slice(offset, offset + charsPerFrame);
      frame += 1;
      if (frame % 3 === 0) {
        scrollContainer?.scrollTo?.({ top: scrollContainer.scrollHeight, behavior: "auto" });
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }

  scrollChatToBottom("auto", true);
}

export function bindAccordion(root) {
  const header = root.querySelector(".accordion-header");
  if (!header) return;

  const chevronInit = header.querySelector(".chevron-icon");
  if (chevronInit) chevronInit.classList.add("-rotate-90");

  header.addEventListener("click", () => {
    const grid = header.nextElementSibling;
    const content = grid?.classList.contains("accordion-grid") ? grid.querySelector(".accordion-content") : grid;
    const chevron = header.querySelector(".chevron-icon");
    const isExpanded = header.getAttribute("aria-expanded") === "true";

    if (isExpanded) {
      header.setAttribute("aria-expanded", "false");
      if (grid?.classList.contains("accordion-grid")) grid.style.gridTemplateRows = "0fr";
      else if (content) {
        content.classList.remove("max-h-screen", "opacity-100");
        content.classList.add("max-h-0", "opacity-0");
      }
      if (content && grid?.classList.contains("accordion-grid")) {
        content.classList.remove("opacity-100");
        content.classList.add("opacity-0");
      }
      chevron?.classList.add("-rotate-90");
    } else {
      header.setAttribute("aria-expanded", "true");
      if (grid?.classList.contains("accordion-grid")) grid.style.gridTemplateRows = "1fr";
      else if (content) {
        content.classList.remove("max-h-0", "opacity-0");
        content.classList.add("max-h-screen", "opacity-100");
      }
      if (content && grid?.classList.contains("accordion-grid")) {
        content.classList.remove("opacity-0");
        content.classList.add("opacity-100");
      }
      chevron?.classList.remove("-rotate-90");
    }
  });
}
