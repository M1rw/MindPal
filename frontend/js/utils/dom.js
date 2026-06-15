export { escapeHtml, scrollChatToBottom } from "../ui_state.js?v=20260615-streaming-v7";

export function formatMarkdown(text) {
  const escaped = String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .replace(/\*\*(.*?)\*\*/g, '<strong class="text-gray-900 dark:text-gray-100 font-semibold">$1</strong>')
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/\n\n/g, "<br><br>")
    .replace(/\n/g, "<br>");
}

export function stripMarkdown(text) {
  return String(text || "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1");
}

export function appendSectionLine(currentValue, line) {
  const clean = String(line || "").trim();
  if (!clean) return currentValue;
  return currentValue ? `${currentValue}\n${clean}` : clean;
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

  header.addEventListener("click", () => {
    const content = header.nextElementSibling;
    const chevron = header.querySelector(".chevron-icon");
    const collapsedText = header.querySelector(".collapsed-text");
    const expandedText = header.querySelector(".expanded-text");

    const isOpen = !content?.classList.contains("max-h-0");

    if (isOpen) {
      content.classList.remove("max-h-screen", "opacity-100");
      content.classList.add("max-h-0", "opacity-0");
      chevron?.classList.remove("rotate-90");
      collapsedText?.classList.remove("hidden");
      expandedText?.classList.add("hidden");
    } else {
      content?.classList.remove("max-h-0", "opacity-0");
      content?.classList.add("max-h-screen", "opacity-100");
      chevron?.classList.add("rotate-90");
      collapsedText?.classList.add("hidden");
      expandedText?.classList.remove("hidden");
    }
  });
}
