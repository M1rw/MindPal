/**
 * Escape untrusted text before inserting it into an HTML template.
 *
 * This module is deliberately dependency-free so text and DOM helpers do not
 * need to import application state just to render a safe string.
 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
