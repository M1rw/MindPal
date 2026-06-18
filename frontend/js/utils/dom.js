export { scrollChatToBottom } from "../ui_state.js";

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function formatMarkdown(text) {
  let result = String(text || "");

  // 1. Fenced code blocks: ```lang\n...\n``` → styled <pre><code>
  result = result.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_match, lang, code) => {
      const escaped = code
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n$/, ""); // trim trailing newline inside block
      const langLabel = lang
        ? `<div class="code-lang-label">${lang}</div>`
        : "";
      return `<div class="code-block-wrap">${langLabel}<pre class="code-block"><code>${escaped}</code></pre></div>`;
    },
  );

  // 2. Escape HTML in remaining (non-code-block) text
  //    Split on code blocks we already rendered, escape only non-code parts
  const parts = result.split(/(<div class="code-block-wrap">[\s\S]*?<\/div>)/g);
  result = parts
    .map((part) => {
      if (part.startsWith('<div class="code-block-wrap">')) return part;
      // Escape HTML
      let p = part.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      // 3. Inline code: `code` → <code class="inline-code">
      p = p.replace(/`([^`\n]+?)`/g, '<code class="inline-code">$1</code>');
      // 4. Bold: **text**
      p = p.replace(/\*\*(.*?)\*\*/g, '<strong class="text-gray-900 dark:text-gray-100 font-semibold">$1</strong>');
      // 5. Italic: *text*
      p = p.replace(/\*(.*?)\*/g, "<em>$1</em>");
      // 6. Unordered lists: lines starting with - or •
      p = p.replace(/(?:^|\n)([ \t]*[-•])\s+(.+)/g, (_m, _bullet, content) => `\n<li class="ml-4 list-disc">${content}</li>`);
      // 7. Ordered lists: lines starting with 1. 2. etc
      p = p.replace(/(?:^|\n)([ \t]*\d+\.)\s+(.+)/g, (_m, _num, content) => `\n<li class="ml-4 list-decimal">${content}</li>`);
      // 8. Paragraphs / line breaks
      p = p.replace(/\n\n/g, "<br><br>");
      p = p.replace(/\n/g, "<br>");
      return p;
    })
    .join("");

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
  element.innerHTML = "";
  const tokens = html.match(/(<[^>]+>|[^<]+)/g) || [];
  let currentHTML = "";

  for (const token of tokens) {
    if (token.startsWith("<")) {
      currentHTML += token;
      element.innerHTML = currentHTML;
      continue;
    }

    for (let index = 0; index < token.length; index += 1) {
      currentHTML += token.charAt(index);
      element.innerHTML = currentHTML;

      if (index % 3 === 0) {
        scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: "auto" });
      }

      await sleep(6);
    }
  }

  scrollChatToBottom("auto");
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
