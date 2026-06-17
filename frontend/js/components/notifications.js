// frontend/js/components/notifications.js — In-app + push notification engine
//
// Three notification channels:
//   1. responseComplete  — fires when a streamed reply finishes while the tab is hidden
//   2. streakReminders   — periodic check: if user has a streak > 0 and hasn't chatted today
//   3. moodCheckIn       — gentle evening prompt (7–9 PM local) once per day

import { getAppSettings } from "../settings_store.js";

// ═══════════════════════════════════════════════════════════════
// Internal state
// ═══════════════════════════════════════════════════════════════

const _state = {
  /** ID for the streak/mood interval timer */
  intervalId: null,
  /** ISO date key for last mood check-in shown today */
  lastMoodCheckDate: null,
  /** ISO date key for last streak reminder shown today */
  lastStreakReminderDate: null,
  /** Show toast callback — injected from app.js */
  showToast: () => {},
  /** Get current streak — injected from ui_state.js */
  getStreakSnapshot: () => ({ currentStreak: 0, todayKey: "" }),
};

// ═══════════════════════════════════════════════════════════════
// Init — called once from app.js bootstrap
// ═══════════════════════════════════════════════════════════════

/**
 * @param {Object} deps
 * @param {Function} deps.showToast   - (message: string) => void
 * @param {Function} deps.getStreakSnapshot - () => { currentStreak, todayKey, activeDays }
 */
export function initNotifications(deps) {
  _state.showToast = deps.showToast || _state.showToast;
  _state.getStreakSnapshot = deps.getStreakSnapshot || _state.getStreakSnapshot;

  // Load persisted state
  try {
    _state.lastMoodCheckDate = localStorage.getItem("mindpal_last_mood_check") || null;
    _state.lastStreakReminderDate = localStorage.getItem("mindpal_last_streak_reminder") || null;
  } catch { /* localStorage may be unavailable */ }

  // Start periodic checks every 10 minutes
  _startPeriodicChecks();
}

// ═══════════════════════════════════════════════════════════════
// 1. Response Complete
// ═══════════════════════════════════════════════════════════════

/**
 * Call this when a streamed response finishes.
 * Only fires if the tab is hidden AND the user has the setting enabled.
 */
export function notifyResponseComplete() {
  if (!document.hidden) return; // Tab is visible — user saw it live

  const setting = _getNotifSetting("responseComplete");
  if (setting === "off") return;

  const title = "MindPal";
  const body = "Your response is ready";

  if (setting === "push") {
    _sendPush(title, body);
  } else if (setting === "in_app") {
    // Queue toast for when tab regains focus
    _onNextVisibility(() => _state.showToast(body));
  }
}

// ═══════════════════════════════════════════════════════════════
// 2. Streak Reminders
// ═══════════════════════════════════════════════════════════════

function _checkStreakReminder() {
  const setting = _getNotifSetting("streakReminders");
  if (setting === "off") return;

  const snapshot = _state.getStreakSnapshot();
  const { currentStreak, todayKey, activeDays } = snapshot;

  // Only remind if user has a streak worth protecting (≥ 1 day)
  // and hasn't chatted today yet
  if (currentStreak < 1) return;
  if (activeDays && activeDays.has(todayKey)) return; // Already active today

  // Only remind once per day
  if (_state.lastStreakReminderDate === todayKey) return;

  // Only remind in the afternoon/evening (after 2 PM local)
  const hour = new Date().getHours();
  if (hour < 14) return;

  _state.lastStreakReminderDate = todayKey;
  try { localStorage.setItem("mindpal_last_streak_reminder", todayKey); } catch {}

  const body = `🔥 Your ${currentStreak}-day streak is at risk! Send a message to keep it going.`;

  if (setting === "push" && document.hidden) {
    _sendPush("MindPal", body);
  } else {
    _state.showToast(body);
  }
}

// ═══════════════════════════════════════════════════════════════
// 3. Mood Check-in
// ═══════════════════════════════════════════════════════════════

function _checkMoodCheckIn() {
  const setting = _getNotifSetting("moodCheckIn");
  if (setting === "off") return;

  const now = new Date();
  const hour = now.getHours();

  // Only trigger between 7 PM and 9 PM local
  if (hour < 19 || hour > 21) return;

  const todayKey = now.toISOString().slice(0, 10);

  // Only once per day
  if (_state.lastMoodCheckDate === todayKey) return;
  _state.lastMoodCheckDate = todayKey;
  try { localStorage.setItem("mindpal_last_mood_check", todayKey); } catch {}

  const body = "🌙 Evening check-in: How are you feeling right now? Take a moment to reflect.";

  if (setting === "push" && document.hidden) {
    _sendPush("MindPal", body);
  } else {
    _state.showToast(body);
  }
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function _getNotifSetting(key) {
  const settings = getAppSettings();
  return settings?.notifications?.[key] || "off";
}

function _sendPush(title, body) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") {
    // Fall back to in-app
    _state.showToast(body);
    return;
  }

  try {
    const n = new Notification(title, {
      body,
      icon: "/favicon.ico",
      tag: `mindpal-${Date.now()}`,
      silent: false,
    });

    // Auto-close after 6 seconds
    setTimeout(() => n.close(), 6000);

    // Focus tab on click
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // Notification constructor can throw in some contexts
    _state.showToast(body);
  }
}

function _onNextVisibility(callback) {
  if (!document.hidden) {
    callback();
    return;
  }

  const handler = () => {
    if (!document.hidden) {
      document.removeEventListener("visibilitychange", handler);
      // Small delay so it doesn't flash immediately
      setTimeout(callback, 500);
    }
  };
  document.addEventListener("visibilitychange", handler);
}

function _startPeriodicChecks() {
  // Clear any existing interval
  if (_state.intervalId) clearInterval(_state.intervalId);

  // Run checks every 10 minutes
  _state.intervalId = setInterval(() => {
    _checkStreakReminder();
    _checkMoodCheckIn();
  }, 10 * 60 * 1000);

  // Also run immediately on visibility change (user returns to tab)
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      _checkStreakReminder();
      _checkMoodCheckIn();
    }
  });

  // Initial check after a short delay
  setTimeout(() => {
    _checkStreakReminder();
    _checkMoodCheckIn();
  }, 5000);
}
