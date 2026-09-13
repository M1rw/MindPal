// frontend/js/utils/helpers.js — Small general-purpose utilities

/**
 * Generate a cryptographically random hex ID (16 chars).
 */
export function cryptoRandomId() {
  if (window.crypto?.getRandomValues) {
    const bytes = new Uint8Array(8);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  return Math.random().toString(36).slice(2, 12);
}

/**
 * Normalize a user name — returns "Friend" for empty/blank values.
 */
export function normalizeName(value) {
  const clean = String(value || "").trim();
  return clean || "Friend";
}
