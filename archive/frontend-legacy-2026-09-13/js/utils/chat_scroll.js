/**
 * Scroll the chat history when the user is already near the bottom.
 *
 * This utility intentionally owns no application state. Callers that need to
 * force a scroll can pass `force: true`.
 */
let scrollAnimationFrame = null;

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

    chatHistory.scrollTo({
      top: chatHistory.scrollHeight,
      behavior: behavior === "smooth" ? "smooth" : "auto",
    });
  });
}
