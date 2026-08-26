// frontend/js/components/usage_tracker.js — Client-side usage tracking with pre-flight check
//
// Dual-window credit system:
//   5-hour window: 50 credits total
//   1-week window: 500 credits total
//   Standard message = 1 credit, Pro message = 2 credits
//
// For guest (non-authenticated) users, credits are tracked in localStorage.
// For authenticated users, backend is the source of truth and syncs via stream metadata.

const STORAGE_KEY = "mindpal_usage_v1";

const LIMITS = {
  credits_5h: 50,
  credits_week: 500,
  WINDOW_5H_MS: 5 * 60 * 60 * 1000,
  WINDOW_WEEK_MS: 7 * 24 * 60 * 60 * 1000,
};

// ═══════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════

const _usage = {
  credits_5h: 0,
  credits_5h_reset: 0,   // epoch ms
  credits_week: 0,
  credits_week_reset: 0,  // epoch ms
  total_messages: 0,
};

let _showToast = () => {};
let _showBanner = () => {};
let _hideBanner = () => {};

// ═══════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════

/**
 * @param {Object} deps
 * @param {Function} deps.showToast - (msg: string) => void
 */
export function initUsageTracker(deps = {}) {
  _showToast = deps.showToast || _showToast;

  // Load from localStorage for guest users
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      Object.assign(_usage, saved);
    }
  } catch { /* ignore */ }

  // Auto-reset expired windows
  _checkAndResetWindows();

  // Create the quota banner element
  _createQuotaBanner();
}

// ═══════════════════════════════════════════════════════════════
// Pre-flight check — call BEFORE any API call
// ═══════════════════════════════════════════════════════════════

/**
 * Returns true if the user can send a message with the given model.
 * Shows a banner + toast if usage is exhausted.
 *
 * @param {"standard"|"pro"} model
 * @returns {boolean}
 */
export function canSendMessage(model = "standard") {
  _checkAndResetWindows();

  const cost = model === "pro" ? 2 : 1;
  const remaining5h = LIMITS.credits_5h - _usage.credits_5h;
  const remainingWeek = LIMITS.credits_week - _usage.credits_week;

  if (remaining5h < cost) {
    const resetMs = Math.max(0, (_usage.credits_5h_reset + LIMITS.WINDOW_5H_MS) - Date.now());
    const resetMin = Math.ceil(resetMs / 60000);
    _showQuotaBanner(`Usage limit reached. Resets in ${_formatTime(resetMin)}.`);
    return false;
  }

  if (remainingWeek < cost) {
    const resetMs = Math.max(0, (_usage.credits_week_reset + LIMITS.WINDOW_WEEK_MS) - Date.now());
    const resetHrs = Math.ceil(resetMs / 3600000);
    _showQuotaBanner(`Weekly usage limit reached. Resets in ${resetHrs}h.`);
    return false;
  }

  // If we were showing a banner but user now has credits, hide it
  _hideQuotaBanner();
  return true;
}

// ═══════════════════════════════════════════════════════════════
// Record a message (client-side tracking for guests)
// ═══════════════════════════════════════════════════════════════

/**
 * Record a message send. For guests this is the source of truth.
 * For authenticated users, the backend response will overwrite via syncFromBackend.
 *
 * @param {"standard"|"pro"} model
 */
export function recordMessage(model = "standard") {
  _checkAndResetWindows();
  const cost = model === "pro" ? 2 : 1;

  _usage.credits_5h += cost;
  _usage.credits_week += cost;
  _usage.total_messages += 1;

  // Initialize reset times if not set
  if (!_usage.credits_5h_reset) _usage.credits_5h_reset = Date.now();
  if (!_usage.credits_week_reset) _usage.credits_week_reset = Date.now();

  _persist();

  // Warn at 80% of 5h window
  const pct5h = (_usage.credits_5h / LIMITS.credits_5h) * 100;
  if (pct5h >= 80 && pct5h < 100) {
    const remaining = LIMITS.credits_5h - _usage.credits_5h;
    _showToast(`⚡ ${remaining} credits remaining in this window.`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Sync from backend metadata (authenticated users)
// ═══════════════════════════════════════════════════════════════

/**
 * Update local usage state from backend stream metadata.
 * Called when a stream response includes a `usage` object.
 *
 * @param {Object} backendUsage - { credits_5h, limit_5h, reset_5h_seconds, credits_week, limit_week, reset_week_seconds, total_messages }
 */
export function syncFromBackend(backendUsage) {
  if (!backendUsage) return;

  const now = Date.now();
  _usage.credits_5h = backendUsage.credits_5h ?? _usage.credits_5h;
  _usage.credits_week = backendUsage.credits_week ?? _usage.credits_week;
  _usage.total_messages = backendUsage.total_messages ?? _usage.total_messages;

  // Convert reset_seconds to absolute timestamps
  if (typeof backendUsage.reset_5h_seconds === "number") {
    _usage.credits_5h_reset = now - (LIMITS.WINDOW_5H_MS - backendUsage.reset_5h_seconds * 1000);
  }
  if (typeof backendUsage.reset_week_seconds === "number") {
    _usage.credits_week_reset = now - (LIMITS.WINDOW_WEEK_MS - backendUsage.reset_week_seconds * 1000);
  }

  _persist();

  // Check if we should show/hide the banner
  const remaining5h = LIMITS.credits_5h - _usage.credits_5h;
  const remainingWeek = LIMITS.credits_week - _usage.credits_week;
  if (remaining5h <= 0 || remainingWeek <= 0) {
    const resetMs = Math.max(0, (_usage.credits_5h_reset + LIMITS.WINDOW_5H_MS) - Date.now());
    const resetMin = Math.ceil(resetMs / 60000);
    _showQuotaBanner(`Usage limit reached. Resets in ${_formatTime(resetMin)}.`);
  } else {
    _hideQuotaBanner();
  }
}

// ═══════════════════════════════════════════════════════════════
// Get current usage summary (for settings UI)
// ═══════════════════════════════════════════════════════════════

export function getUsageSummary() {
  _checkAndResetWindows();
  const now = Date.now();

  return {
    credits_5h: _usage.credits_5h,
    limit_5h: LIMITS.credits_5h,
    pct_5h: Math.min(100, (_usage.credits_5h / LIMITS.credits_5h) * 100),
    reset_5h_ms: Math.max(0, (_usage.credits_5h_reset + LIMITS.WINDOW_5H_MS) - now),

    credits_week: _usage.credits_week,
    limit_week: LIMITS.credits_week,
    pct_week: Math.min(100, (_usage.credits_week / LIMITS.credits_week) * 100),
    reset_week_ms: Math.max(0, (_usage.credits_week_reset + LIMITS.WINDOW_WEEK_MS) - now),

    total_messages: _usage.total_messages,
  };
}

/**
 * Update the Usage & Quota settings panel DOM with current values.
 * Safe to call anytime — silently no-ops if elements aren't present.
 */
export function renderUsagePanel() {
  const summary = getUsageSummary();

  // 5-hour window
  const bar5h = document.getElementById("usage-5h-bar");
  const text5h = document.getElementById("usage-5h-text");
  const reset5h = document.getElementById("usage-5h-reset");

  if (bar5h) {
    bar5h.style.width = `${summary.pct_5h}%`;
    bar5h.classList.toggle("warn", summary.pct_5h >= 70 && summary.pct_5h < 100);
    bar5h.classList.toggle("full", summary.pct_5h >= 100);
  }
  if (text5h) text5h.textContent = `${summary.credits_5h} / ${summary.limit_5h}`;
  if (reset5h) {
    const mins = Math.ceil(summary.reset_5h_ms / 60000);
    reset5h.textContent = summary.credits_5h > 0 ? `Resets in ${_formatTime(mins)}` : "Not started";
  }

  // Weekly window
  const barWeek = document.getElementById("usage-week-bar");
  const textWeek = document.getElementById("usage-week-text");
  const resetWeek = document.getElementById("usage-week-reset");

  if (barWeek) {
    barWeek.style.width = `${summary.pct_week}%`;
    barWeek.classList.toggle("warn", summary.pct_week >= 70 && summary.pct_week < 100);
    barWeek.classList.toggle("full", summary.pct_week >= 100);
  }
  if (textWeek) textWeek.textContent = `${summary.credits_week} / ${summary.limit_week}`;
  if (resetWeek) {
    const hrs = Math.ceil(summary.reset_week_ms / 3600000);
    resetWeek.textContent = summary.credits_week > 0 ? `Resets in ${hrs}h` : "Not started";
  }

  // Total messages
  const totalEl = document.getElementById("usage-total-messages");
  if (totalEl) totalEl.textContent = String(summary.total_messages);
}

// ═══════════════════════════════════════════════════════════════
// Quota banner — notification bar above chat input
// ═══════════════════════════════════════════════════════════════

let _bannerEl = null;

function _createQuotaBanner() {
  if (_bannerEl) return;

  _bannerEl = document.createElement("div");
  _bannerEl.id = "quota-banner";
  _bannerEl.className = "quota-banner hidden";
  _bannerEl.innerHTML = `
    <div class="quota-banner-inner">
      <i data-lucide="alert-circle" class="w-4 h-4 flex-none"></i>
      <span class="quota-banner-text"></span>
    </div>
  `;

  // Insert above chat input area
  const inputArea = document.getElementById("chat-input-area") || document.getElementById("input-area");
  if (inputArea) {
    inputArea.parentElement?.insertBefore(_bannerEl, inputArea);
  } else {
    // Fallback: append to main
    document.querySelector("main")?.appendChild(_bannerEl);
  }
}

function _showQuotaBanner(message) {
  if (!_bannerEl) _createQuotaBanner();
  if (!_bannerEl) return;

  const textEl = _bannerEl.querySelector(".quota-banner-text");
  if (textEl) textEl.textContent = message;
  _bannerEl.classList.remove("hidden");

  // Refresh icons for the alert-circle
  try {
    if (window.lucide) window.lucide.createIcons({ nodes: [_bannerEl] });
  } catch { /* ignore */ }
}

function _hideQuotaBanner() {
  if (_bannerEl) _bannerEl.classList.add("hidden");
}

// ═══════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════

function _checkAndResetWindows() {
  const now = Date.now();

  if (_usage.credits_5h_reset && (now - _usage.credits_5h_reset > LIMITS.WINDOW_5H_MS)) {
    _usage.credits_5h = 0;
    _usage.credits_5h_reset = now;
  }

  if (_usage.credits_week_reset && (now - _usage.credits_week_reset > LIMITS.WINDOW_WEEK_MS)) {
    _usage.credits_week = 0;
    _usage.credits_week_reset = now;
  }
}

function _persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_usage));
  } catch { /* ignore */ }
}

function _formatTime(minutes) {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
