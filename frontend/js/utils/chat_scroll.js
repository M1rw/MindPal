/**
 * Scroll the chat history when the user is already near the bottom.
 *
 * This utility intentionally owns no application state. Callers that need to
 * force a scroll can pass `force: true`.
 */
let scrollAnimationFrame = null;
let observerInitialized = false;

export function scrollChatToBottom(behavior = "auto", force = false) {
  if (scrollAnimationFrame) {
    cancelAnimationFrame(scrollAnimationFrame);
  }
  scrollAnimationFrame = requestAnimationFrame(() => {
    scrollAnimationFrame = null;
    const chatHistory = document.getElementById("chat-history");
    if (!chatHistory) return;

    const isNearBottom = chatHistory.scrollHeight - chatHistory.scrollTop - chatHistory.clientHeight < 150;
    if (!force && !isNearBottom) return;

    if (behavior === "smooth") {
      chatHistory.scrollTo({
        top: chatHistory.scrollHeight,
        behavior: "smooth",
      });
    } else {
      chatHistory.scrollTop = chatHistory.scrollHeight;
    }
  });
}

export function initAutoScrollObserver() {
  if (observerInitialized) return;
  const chatHistory = document.getElementById("chat-history");
  if (!chatHistory) return;

  observerInitialized = true;
  const observer = new MutationObserver(() => {
    const isNearBottom = chatHistory.scrollHeight - chatHistory.scrollTop - chatHistory.clientHeight < 200;
    if (isNearBottom) {
      scrollChatToBottom("auto", true);
    }
  });

  observer.observe(chatHistory, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}
