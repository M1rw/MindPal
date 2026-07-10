import DOMPurify from "dompurify";
import { scrollChatToBottom } from "../ui_state.js";
export { scrollChatToBottom };

const RICH_HTML_POLICY = Object.freeze({
  ALLOWED_TAGS: [
    "br", "code", "div", "em", "i", "li", "ol", "pre", "span", "strong", "ul",
    "button", "svg", "polyline", "path",
  ],
  ALLOWED_ATTR: [
    "aria-controls", "aria-expanded", "aria-hidden", "class", "data-lucide", "data-target",
    "dir", "fill", "height", "id", "role", "stroke", "stroke-linecap",
    "stroke-linejoin", "stroke-width", "style", "type", "viewBox", "width",
  ],
  ALLOW_DATA_ATTR: false,
});

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

export function formatMarkdown(text) {
  const codeBlocks = [];
  let result = String(text || "").replace(/```([\w+-]*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const escaped = escapeHtml(code.replace(/\n$/, ""));
    const safeLang = escapeHtml(lang || "");
    const html = `<div class="code-block-wrap">${safeLang ? `<div class="code-lang-label">${safeLang}</div>` : ""}<pre class="code-block"><code>${escaped}</code></pre></div>`;
    const token = `@@MINDPAL_CODE_BLOCK_${codeBlocks.length}@@`;
    codeBlocks.push(html);
    return token;
  });

  result = escapeHtml(result);
  result = result.replace(/`([^`\n]+?)`/g, '<code class="inline-code">$1</code>');
  result = result.replace(/\*\*(.*?)\*\*/g, '<strong class="text-gray-900 dark:text-gray-100 font-semibold">$1</strong>');
  result = result.replace(/(^|[^*])\*([^*\n]+?)\*/g, "$1<em>$2</em>");
  result = result.replace(/(?:^|\n)[ \t]*[-•]\s+(.+)/g, (_match, content) => `\n<li class="ml-4 list-disc">${content}</li>`);
  result = result.replace(/(?:^|\n)[ \t]*\d+\.\s+(.+)/g, (_match, content) => `\n<li class="ml-4 list-decimal">${content}</li>`);
  result = result.replace(/\n\n/g, "<br><br>").replace(/\n/g, "<br>");

  for (let index = 0; index < codeBlocks.length; index += 1) {
    result = result.replace(`@@MINDPAL_CODE_BLOCK_${index}@@`, codeBlocks[index]);
  }
  return result;
}

export function stripMarkdown(text) {
  return String(text || "")
    .replace(/```\w*\n?/g, "")       // strip fenced code block markers
    .replace(/`([^`\n]+?)`/g, "$1")  // strip inline code backticks
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1");
}


export function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function typewriteHTML(element, html, scrollContainer) {
  const template = document.createElement("template");
  // Callers provide HTML produced by formatMarkdown/processStructuredResponse,
  // which escape user/model text before adding the small supported tag set.
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

  const CHARS_PER_FRAME = 6;
  let frame = 0;
  for (const item of textNodes) {
    for (let offset = 0; offset < item.fullText.length; offset += CHARS_PER_FRAME) {
      item.node.textContent += item.fullText.slice(offset, offset + CHARS_PER_FRAME);
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

  // Start collapsed: rotate chevron-down to point right (-90°)
  const chevronInit = header.querySelector(".chevron-icon");
  if (chevronInit) chevronInit.classList.add("-rotate-90");

  header.addEventListener("click", () => {
    const grid = header.nextElementSibling;
    const content = grid?.classList.contains("accordion-grid") ? grid.querySelector(".accordion-content") : grid;
    const chevron = header.querySelector(".chevron-icon");

    const isExpanded = header.getAttribute("aria-expanded") === "true";

    if (isExpanded) {
      // Collapse
      header.setAttribute("aria-expanded", "false");
      if (grid?.classList.contains("accordion-grid")) {
        grid.style.gridTemplateRows = "0fr";
      } else if (content) {
        content.classList.remove("max-h-screen", "opacity-100");
        content.classList.add("max-h-0", "opacity-0");
      }
      
      if (content && grid?.classList.contains("accordion-grid")) {
        content.classList.remove("opacity-100");
        content.classList.add("opacity-0");
      }
      
      chevron?.classList.add("-rotate-90");
    } else {
      // Expand
      header.setAttribute("aria-expanded", "true");
      if (grid?.classList.contains("accordion-grid")) {
        grid.style.gridTemplateRows = "1fr";
      } else if (content) {
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
