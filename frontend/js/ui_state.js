// frontend/js/ui_state.js
// Orchestrates app state, theme, UI updates — delegates utils to dedicated modules.

import { refreshIcons } from "./utils/icons.js";
import {
  getLocalDateKey,
  normalizeDayKeys,
  normalizeDateKey,
  computeCurrentStreak,
  getMostRecentActiveDate,
  getLast7Days,
} from "./utils/dates.js";
import { cryptoRandomId, normalizeName } from "./utils/helpers.js";

// Re-export so existing consumers don't break
export { refreshIcons } from "./utils/icons.js";

const STATE_KEY = "mindpal_state_v2";

const DEFAULT_STATE = Object.freeze({
  sessionId: "",
  chatMemory: [],
  streak: 0,
  lastVisitDate: null,
  visitHistory: [],
  crisisMode: true,
  cloudSyncEnabled: false,
  userName: "Friend",
  messageCount: 0,
});

let state = createDefaultState();
let deferredStateSaveTimer = null;

// ═══════════════════════════════════════════════════════════════
// State CRUD
// ═══════════════════════════════════════════════════════════════

export function createDefaultState() {
  return {
    ...DEFAULT_STATE,
    sessionId: `mp_${cryptoRandomId()}`,
    chatMemory: [],
    visitHistory: [],
  };
}

export function loadState() {
  const saved = localStorage.getItem(STATE_KEY);

  if (!saved) {
    state = createDefaultState();
    calculateStreak();
    saveState();
    return state;
  }

  try {
    const parsed = JSON.parse(saved);

    state = {
      ...createDefaultState(),
      ...parsed,
      chatMemory: Array.isArray(parsed.chatMemory) ? parsed.chatMemory : [],
      visitHistory: Array.isArray(parsed.visitHistory) ? parsed.visitHistory : [],
      crisisMode: parsed.crisisMode !== false,
      userName: normalizeName(parsed.userName),
    };

    calculateStreak();
    saveState();
    return state;
  } catch {
    state = createDefaultState();
    calculateStreak();
    saveState();
    return state;
  }
}

export function saveState({ defer = false } = {}) {
  const write = () => {
    deferredStateSaveTimer = null;
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  };

  if (!defer) {
    if (deferredStateSaveTimer !== null) {
      window.clearTimeout(deferredStateSaveTimer);
      deferredStateSaveTimer = null;
    }
    write();
    return;
  }

  if (deferredStateSaveTimer !== null) return;

  const schedule = window.requestIdleCallback || ((callback) => window.setTimeout(callback, 120));
  deferredStateSaveTimer = schedule(write, { timeout: 1_000 });
}

export function getState() {
  return state;
}

export function patchState(patch) {
  state = {
    ...state,
    ...patch,
  };

  saveState();
  return state;
}

export function setUserName(name) {
  state.userName = normalizeName(name);
  saveState();
  return state.userName;
}

export function setCloudSyncEnabled(enabled) {
  state.cloudSyncEnabled = Boolean(enabled);
  saveState();
}

export function setCrisisMode(enabled) {
  state.crisisMode = Boolean(enabled);
  saveState();
}

// ═══════════════════════════════════════════════════════════════
// Chat memory
// ═══════════════════════════════════════════════════════════════

export function addMessage(role, text, extra = {}) {
  const normalizedRole = role === "User" || role === "user" ? "User" : "MindPal";
  const cleanText = String(text || "").trim();

  if (!cleanText) return null;

  const now = new Date().toISOString();

  const message = {
    role: normalizedRole,
    text: cleanText,
    messageId: extra.messageId || extra.message_id || `msg_${cryptoRandomId()}_${Date.now()}`,
    createdAt: extra.createdAt || extra.created_at || now,
    syncStatus: extra.syncStatus || "local",
    ...extra,
  };

  state.chatMemory.push(message);

  if (normalizedRole === "User") {
    state.messageCount += 1;
    recordDailyActivity({ save: false });
  }

  saveState({ defer: true });
  return message;
}

export function replaceChatMemory(messages) {
  state.chatMemory = Array.isArray(messages)
    ? messages
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          ...item,
          role: item.role === "User" || item.role === "user" ? "User" : "MindPal",
          text: String(item.text || item.content || "").trim(),
          messageId: item.messageId || item.message_id || `msg_${cryptoRandomId()}_${Date.now()}`,
          createdAt: item.createdAt || item.created_at || new Date().toISOString(),
        }))
        .filter((item) => item.text)
    : [];

  state.messageCount = state.chatMemory.filter((item) => item.role === "User").length;
  saveState({ defer: true });
}

export function clearChatMemory() {
  state.chatMemory = [];
  state.messageCount = 0;
  saveState();
}

// ═══════════════════════════════════════════════════════════════
// Streak & activity tracking
// ═══════════════════════════════════════════════════════════════

export function calculateStreak() {
  normalizeVisitHistory();

  const snapshot = getStreakSnapshot();

  state.streak = snapshot.currentStreak;
  state.lastVisitDate = snapshot.lastActiveDate;

  updateStreakUI(snapshot);
  return state.streak;
}

export function recordDailyActivity({ save = true } = {}) {
  normalizeVisitHistory();

  const todayKey = getLocalDateKey();

  if (!state.visitHistory.includes(todayKey)) {
    state.visitHistory.push(todayKey);
  }

  state.visitHistory = normalizeDayKeys(state.visitHistory);
  state.lastVisitDate = todayKey;

  const snapshot = getStreakSnapshot(todayKey);

  state.streak = snapshot.currentStreak;
  state.lastVisitDate = snapshot.lastActiveDate;

  updateStreakUI(snapshot);

  if (save) {
    saveState();
  }

  return snapshot;
}

export function getStreakSnapshot(todayKey = getLocalDateKey()) {
  normalizeVisitHistory();

  const activeDays = new Set(state.visitHistory);
  const currentStreak = computeCurrentStreak(activeDays, todayKey);
  const lastActiveDate = getMostRecentActiveDate(activeDays);

  return {
    todayKey,
    activeDays,
    currentStreak,
    lastActiveDate,
    weekDays: getLast7Days(todayKey),
  };
}

export function updateStreakUI(snapshot = null) {
  const streakCounter = document.getElementById("streak-counter");
  const modalStreakCount = document.getElementById("modal-streak-count");
  const statDays = document.getElementById("stat-days");

  const nextSnapshot = snapshot || getStreakSnapshot();
  const value = String(Number(nextSnapshot.currentStreak || 0));

  state.streak = Number(nextSnapshot.currentStreak || 0);
  state.lastVisitDate = nextSnapshot.lastActiveDate;

  if (streakCounter) {
    streakCounter.textContent = value;
  }

  if (modalStreakCount) {
    modalStreakCount.textContent = value;
  }

  if (statDays) {
    statDays.textContent = String(nextSnapshot.activeDays.size);
  }
}

function normalizeVisitHistory() {
  state.visitHistory = normalizeDayKeys(state.visitHistory);

  if (state.lastVisitDate) {
    const normalizedLastVisit = normalizeDateKey(state.lastVisitDate);

    if (normalizedLastVisit) {
      state.lastVisitDate = normalizedLastVisit;

      if (!state.visitHistory.includes(normalizedLastVisit)) {
        state.visitHistory.push(normalizedLastVisit);
        state.visitHistory = normalizeDayKeys(state.visitHistory);
      }
    } else {
      state.lastVisitDate = getMostRecentActiveDate(new Set(state.visitHistory));
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Theme
// ═══════════════════════════════════════════════════════════════

export function initializeTheme() {
  // Read from the unified settings store; fall back to system preference.
  try {
    const raw = localStorage.getItem("mindpal_app_settings_v1");
    const parsed = raw ? JSON.parse(raw) : null;
    const appearance = parsed?.appearance || "system";
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
    const dark = appearance === "dark" || (appearance === "system" && prefersDark);
    document.documentElement.classList.toggle("dark", dark);

    // Migrate old theme key if present
    const oldKey = localStorage.getItem("mindpal_theme");
    if (oldKey) localStorage.removeItem("mindpal_theme");
  } catch {
    // Graceful fallback — don't crash boot
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
    document.documentElement.classList.toggle("dark", Boolean(prefersDark));
  }
}

export function toggleTheme() {
  // Delegate to settings store so icon, dropdown, and localStorage all stay in sync.
  const { setAppSetting } = _getSettingsStore();
  const willBeDark = !document.documentElement.classList.contains("dark");
  setAppSetting("appearance", willBeDark ? "dark" : "light");
  return willBeDark;
}

// Lazy import to avoid circular dependency at module load time
let _settingsStoreCache = null;
function _getSettingsStore() {
  if (!_settingsStoreCache) {
    // Dynamic import is async; we use a sync cache since settings_store
    // is always loaded before toggleTheme is ever called.
    _settingsStoreCache = { setAppSetting: () => {} };
  }
  return _settingsStoreCache;
}

export function registerSettingsStore(store) {
  _settingsStoreCache = store;
}

// ═══════════════════════════════════════════════════════════════
// Greeting & Profile UI
// ═══════════════════════════════════════════════════════════════

export function setGreeting() {
  const greetingEl = document.getElementById("greeting-text");
  if (!greetingEl) return;

  const hour = new Date().getHours();
  const name = state.userName && state.userName !== "Friend" ? state.userName : "friend";

  let greeting = `Hello, ${name}.`;

  if (hour >= 5 && hour < 12) {
    greeting = `Good morning, ${name}.`;
  } else if (hour >= 12 && hour < 18) {
    greeting = `Good afternoon, ${name}.`;
  } else {
    greeting = `Good evening, ${name}.`;
  }

  greetingEl.textContent = greeting;
}

export function updateProfileUI(user = null) {
  const loggedOutView = document.getElementById("auth-logged-out");
  const loggedInView = document.getElementById("auth-logged-in");
  const profileAvatar = document.getElementById("profile-avatar");
  const envTag = document.getElementById("env-tag");
  const userNameInput = document.getElementById("user-name-input");
  const profileInitial = document.getElementById("profile-initial");
  const statMessages = document.getElementById("stat-messages");
  const statDays = document.getElementById("stat-days");

  const isCloud = Boolean(state.cloudSyncEnabled && user);
  const displayName = normalizeName(user?.displayName || state.userName);
  const initial = displayName && displayName !== "Friend" ? displayName.charAt(0).toUpperCase() : "U";

  if (isCloud) {
    loggedOutView?.classList.add("hidden");
    loggedInView?.classList.remove("hidden");
    loggedInView?.classList.add("flex");

    if (userNameInput) {
      userNameInput.value = displayName !== "Friend" ? displayName : "";
    }

    if (profileInitial) {
      profileInitial.textContent = initial;
    }

    if (statMessages) {
      statMessages.textContent = String(state.chatMemory.filter((item) => item.role === "User").length);
    }

    if (statDays) {
      statDays.textContent = String(state.visitHistory.length);
    }

    if (profileAvatar) {
      profileAvatar.className = "w-8 h-8 rounded-full bg-[#9b72cb] flex items-center justify-center text-white border border-transparent";
      profileAvatar.innerHTML = `<span class="text-sm font-bold">${escapeHtml(initial)}</span>`;
    }

    if (envTag) {
      envTag.innerHTML = `<i data-lucide="cloud" class="w-3 h-3 inline-block mr-1 mb-[2px]"></i>Cloud`;
      envTag.className = "px-2 py-0.5 rounded-md bg-blue-50 dark:bg-blue-900/30 text-[10px] font-medium text-blue-600 dark:text-blue-400 transition-colors flex items-center";
    }
  } else {
    loggedOutView?.classList.remove("hidden");
    loggedInView?.classList.add("hidden");
    loggedInView?.classList.remove("flex");

    if (profileAvatar) {
      profileAvatar.className = "w-8 h-8 rounded-full bg-gray-200 dark:bg-zinc-700 flex items-center justify-center text-gray-600 dark:text-gray-300 border border-gray-300 dark:border-zinc-600";
      profileAvatar.innerHTML = `<i data-lucide="user" class="w-4 h-4"></i>`;
    }

    if (envTag) {
      envTag.textContent = "Local";
      envTag.className = "px-2 py-0.5 rounded-md bg-gemini-surface dark:bg-gemini-darkSurface text-[10px] font-medium text-gray-500 dark:text-gray-400 transition-colors";
    }
  }

  const crisisToggle = document.getElementById("crisis-toggle");
  if (crisisToggle) {
    crisisToggle.checked = Boolean(state.crisisMode);
  }

  // Dynamic email row and delete account visibility
  const emailCopy = document.getElementById("account-email-copy");
  const emailStatus = document.getElementById("account-email-status");
  const deleteAccountBtn = document.getElementById("delete-account-btn");

  if (isCloud && user) {
    if (emailCopy) emailCopy.textContent = user.email || "Cloud identity managed by Firebase.";
    if (emailStatus) emailStatus.textContent = user.email ? "Connected" : "Pending";
    if (deleteAccountBtn) deleteAccountBtn.style.display = "";
  } else {
    if (emailCopy) emailCopy.textContent = "Sign in to connect your cloud identity.";
    if (emailStatus) emailStatus.textContent = "Not connected";
    if (deleteAccountBtn) deleteAccountBtn.style.display = "none";
  }

  setGreeting();
  refreshIcons();
}

export function updateUsageUI(profileResponse = null) {
  const usage = profileResponse?.profile?.usage || null;
  const proBar = document.getElementById("usage-pro-bar");
  const proText = document.getElementById("usage-pro-text");
  
  if (!usage) return;

  const proCount = usage.pro_messages_count || 0;
  const proPct = Math.min(100, (proCount / 40) * 100);
  
  if (proBar) {
    proBar.style.width = `${proPct}%`;
    if (proPct >= 100) {
      proBar.classList.remove("bg-indigo-600", "dark:bg-indigo-500");
      proBar.classList.add("bg-rose-500");
    } else {
      proBar.classList.add("bg-indigo-600", "dark:bg-indigo-500");
      proBar.classList.remove("bg-rose-500");
    }
  }
  
  if (proText) {
    proText.textContent = `${proCount} / 40 Used`;
    if (proPct >= 100) {
      proText.classList.add("text-rose-500");
    } else {
      proText.classList.remove("text-rose-500");
    }
  }

  const proModelOption = document.querySelector('.model-option[data-model="pro"]');
  if (proModelOption && proPct >= 100) {
    proModelOption.classList.add("opacity-50", "cursor-not-allowed", "pointer-events-none");
    const proDesc = proModelOption.querySelector('.text-\\[11px\\]');
    if (proDesc) proDesc.textContent = "Rate limited. Resets soon.";
  } else if (proModelOption) {
    proModelOption.classList.remove("opacity-50", "cursor-not-allowed", "pointer-events-none");
    const proDesc = proModelOption.querySelector('.text-\\[11px\\]');
    if (proDesc) proDesc.textContent = "Deep analysis, diagnostic thinking.";
  }
}

export function updateUsageFromMeta(proUsage) {
  if (!proUsage) return;

  const proBar = document.getElementById("usage-pro-bar");
  const proText = document.getElementById("usage-pro-text");
  const count = proUsage.count || 0;
  const limit = proUsage.limit || 40;
  const pct = Math.min(100, (count / limit) * 100);

  if (proBar) {
    proBar.style.width = `${pct}%`;
    proBar.style.transition = "width 0.5s ease";
    if (pct >= 100) {
      proBar.classList.remove("bg-indigo-600", "dark:bg-indigo-500");
      proBar.classList.add("bg-rose-500");
    } else {
      proBar.classList.add("bg-indigo-600", "dark:bg-indigo-500");
      proBar.classList.remove("bg-rose-500");
    }
  }

  if (proText) {
    proText.textContent = `${count} / ${limit} Used`;
    if (pct >= 100) {
      proText.classList.add("text-rose-500");
    } else {
      proText.classList.remove("text-rose-500");
    }
  }

  const proModelOption = document.querySelector('.model-option[data-model="pro"]');
  if (proModelOption && pct >= 100) {
    proModelOption.classList.add("opacity-50", "cursor-not-allowed", "pointer-events-none");
    const proDesc = proModelOption.querySelector('.text-\\[11px\\]');
    if (proDesc) proDesc.textContent = "Rate limited. Resets soon.";
  } else if (proModelOption) {
    proModelOption.classList.remove("opacity-50", "cursor-not-allowed", "pointer-events-none");
    const proDesc = proModelOption.querySelector('.text-\\[11px\\]');
    if (proDesc) proDesc.textContent = "Deep analysis, diagnostic thinking.";
  }
}

export function updateMentalHealthUI(profileResponse = null) {
  const clinical = profileResponse?.profile?.clinical || null;

  const phq9Chart = document.getElementById("phq9-chart");
  const gad7Chart = document.getElementById("gad7-chart");
  const problemsDisplay = document.getElementById("presenting-problems-display");
  const diagnosesDisplay = document.getElementById("suspected-diagnoses-display");
  const treatmentPlanDisplay = document.getElementById("treatment-plan-display");

  // Mock data for empty states (grey, sample pattern)
  const mockPHQ9 = [
    { score: 8, date: "Sample" }, { score: 12, date: "Sample" }, { score: 14, date: "Sample" },
    { score: 11, date: "Sample" }, { score: 9, date: "Sample" }, { score: 7, date: "Sample" }, { score: 5, date: "Sample" },
  ];
  const mockGAD7 = [
    { score: 6, date: "Sample" }, { score: 9, date: "Sample" }, { score: 12, date: "Sample" },
    { score: 10, date: "Sample" }, { score: 8, date: "Sample" }, { score: 6, date: "Sample" }, { score: 4, date: "Sample" },
  ];

  const renderBars = (data, maxScore, colorClass, isMock) => {
    const barColor = isMock
      ? "bg-gray-300/60 dark:bg-gray-600/40"
      : colorClass;
    const hoverColor = isMock
      ? ""
      : colorClass.replace("/80", "").replace("bg-", "hover:bg-").replace("500", "400");
    return data.map(item => {
      const heightPct = Math.max(5, (item.score / maxScore) * 100);
      return `
        <div class="flex flex-col items-center flex-1 h-full justify-end group relative${isMock ? "" : " cursor-pointer"}">
          <div class="w-full ${barColor} ${hoverColor} rounded-t-sm transition-all duration-300 min-w-[20px]" style="height: ${heightPct}%;"></div>
          <div class="absolute -top-6 bg-black text-white text-[10px] px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity z-10 whitespace-nowrap pointer-events-none">${isMock ? "Sample" : `${item.score} (${item.date})`}</div>
        </div>
      `;
    }).join("");
  };

  if (phq9Chart) {
    const hasData = clinical?.phq9_history && clinical.phq9_history.length > 0;
    const data = hasData ? clinical.phq9_history : mockPHQ9;
    phq9Chart.innerHTML = renderBars(data, 27, "bg-indigo-500/80", !hasData);
  }

  if (gad7Chart) {
    const hasData = clinical?.gad7_history && clinical.gad7_history.length > 0;
    const data = hasData ? clinical.gad7_history : mockGAD7;
    gad7Chart.innerHTML = renderBars(data, 21, "bg-purple-500/80", !hasData);
  }

  if (problemsDisplay) {
    if (clinical?.presenting_problems && clinical.presenting_problems.length > 0) {
      problemsDisplay.innerHTML = "• " + clinical.presenting_problems.map(escapeHtml).join("<br>• ");
    } else {
      problemsDisplay.innerHTML = `<span class="text-gray-400 dark:text-gray-600 italic">• Stress management &nbsp; • Sleep difficulties &nbsp; • Mood regulation</span>`;
    }
  }

  if (diagnosesDisplay) {
    if (clinical?.suspected_diagnoses && clinical.suspected_diagnoses.length > 0) {
      diagnosesDisplay.innerHTML = "• " + clinical.suspected_diagnoses.map(escapeHtml).join("<br>• ");
    } else {
      diagnosesDisplay.innerHTML = `<span class="text-gray-400 dark:text-gray-600 italic">No observations yet — continue chatting with MindPal Pro.</span>`;
    }
  }

  if (treatmentPlanDisplay) {
    treatmentPlanDisplay.textContent = clinical?.treatment_plan || "No active plan — insights build over time through conversations.";
    if (!clinical?.treatment_plan) {
      treatmentPlanDisplay.classList.add("text-gray-400", "dark:text-gray-600", "italic");
    } else {
      treatmentPlanDisplay.classList.remove("text-gray-400", "dark:text-gray-600", "italic");
    }
  }
}



// ═══════════════════════════════════════════════════════════════
// Weekly tracker
// ═══════════════════════════════════════════════════════════════

export function renderWeeklyTracker() {
  const snapshot = getStreakSnapshot();

  updateStreakUI(snapshot);

  const tracker = document.getElementById("weekly-tracker");
  if (!tracker) return;

  tracker.innerHTML = "";

  for (const day of snapshot.weekDays) {
    const isVisited = snapshot.activeDays.has(day.key);
    const isToday = day.key === snapshot.todayKey;
    const label = isToday ? "Today" : day.label;

    let circleClasses = "w-8 h-8 rounded-full flex items-center justify-center text-sm transition-colors ";
    let iconHtml = "";

    if (isVisited) {
      circleClasses += "bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 shadow-sm";
      iconHtml = `<i data-lucide="check" class="w-4 h-4 stroke-[2.5]"></i>`;
    } else if (isToday) {
      circleClasses += "bg-transparent border-[1.5px] border-dashed border-gray-300 dark:border-[#444746] text-transparent";
    } else {
      circleClasses += "bg-gemini-surface dark:bg-gemini-darkSurface border border-gemini-border dark:border-[#444746] text-transparent";
    }

    tracker.insertAdjacentHTML(
      "beforeend",
      `
        <div class="flex flex-col items-center gap-2">
          <span class="text-[11px] ${isToday ? "text-gray-900 dark:text-white font-bold" : "text-gray-400 dark:text-gray-500 font-medium"}">${label}</span>
          <div class="${circleClasses}" title="${day.key}">${iconHtml}</div>
        </div>
      `,
    );
  }

  refreshIcons();
}

// ═══════════════════════════════════════════════════════════════
// Modals
// ═══════════════════════════════════════════════════════════════

export function openModal(modalId, contentId) {
  const modal = document.getElementById(modalId);
  const content = document.getElementById(contentId);

  modal?.classList.remove("opacity-0", "pointer-events-none");
  content?.classList.remove("scale-95");
  document.body.classList.add("overflow-hidden");
}

export function closeModal(modalId, contentId) {
  const modal = document.getElementById(modalId);
  const content = document.getElementById(contentId);

  modal?.classList.add("opacity-0", "pointer-events-none");
  content?.classList.add("scale-95");
  
  const anyModalOpen = document.querySelectorAll('.fixed.inset-0:not(.opacity-0)').length > 0;
  if (!anyModalOpen) {
    document.body.classList.remove("overflow-hidden");
  }
}

// ═══════════════════════════════════════════════════════════════
// Chat UI helpers
// ═══════════════════════════════════════════════════════════════

export function setChatStarted(started) {
  const welcomeScreen = document.getElementById("welcome-screen");
  const chatHistory = document.getElementById("chat-history");
  const interactionArea = document.getElementById("interaction-area");

  if (started) {
    // Capture the input bar's current position before layout change
    const inputBox = interactionArea?.querySelector(".max-w-4xl");
    const firstRect = inputBox?.getBoundingClientRect();

    // Fade out welcome
    welcomeScreen?.classList.add("fade-out");

    setTimeout(() => {
      welcomeScreen?.classList.add("hidden");
      welcomeScreen?.classList.remove("fade-out");

      // Swap layout (input jumps to bottom instantly)
      interactionArea?.classList.remove("flex-1", "justify-center");
      interactionArea?.classList.add("flex-none", "justify-end", "pt-0");

      chatHistory?.classList.remove("hidden");
      chatHistory?.classList.add("flex");

      // FLIP: animate input from old position to new position
      if (inputBox && firstRect) {
        const lastRect = inputBox.getBoundingClientRect();
        const deltaY = firstRect.top - lastRect.top;

        if (Math.abs(deltaY) > 2) {
          inputBox.style.transform = `translateY(${deltaY}px)`;
          inputBox.style.transition = "none";

          // Force reflow
          void inputBox.offsetHeight;

          inputBox.style.transition = "transform 0.45s cubic-bezier(0.4, 0, 0.2, 1)";
          inputBox.style.transform = "translateY(0)";

          inputBox.addEventListener("transitionend", () => {
            inputBox.style.transition = "";
            inputBox.style.transform = "";
          }, { once: true });
        }
      }
    }, 400);
  } else {
    chatHistory?.classList.add("hidden");
    chatHistory?.classList.remove("flex");

    interactionArea?.classList.add("flex-1", "justify-center");
    interactionArea?.classList.remove("flex-none", "justify-end", "pt-0");

    welcomeScreen?.classList.remove("hidden");
  }
}

export function setInputState({ disabled, locked = false }) {
  const inputEl = document.getElementById("chat-input");
  const sendBtn = document.getElementById("send-btn");
  const voiceBtn = document.getElementById("voice-btn");
  const modeBtn = document.getElementById("mode-selector-btn");

  const isDisabled = Boolean(disabled || locked);

  if (inputEl) {
    inputEl.disabled = isDisabled;
    inputEl.placeholder = locked
      ? "Session paused for safety."
      : disabled
        ? "MindPal is responding..."
        : "Ask MindPal";
  }

  if (sendBtn) {
    sendBtn.disabled = isDisabled || !inputEl?.value?.trim();
  }

  if (modeBtn) {
    modeBtn.disabled = isDisabled;
    modeBtn.classList.toggle("opacity-50", isDisabled);
    modeBtn.classList.toggle("pointer-events-none", isDisabled);
  }

  if (voiceBtn) {
    voiceBtn.classList.toggle("opacity-30", isDisabled);
    voiceBtn.classList.toggle("pointer-events-none", isDisabled);
  }
}

export function syncInputButtons() {
  const inputEl = document.getElementById("chat-input");
  const sendBtn = document.getElementById("send-btn");
  const voiceBtn = document.getElementById("voice-btn");

  if (!inputEl || !sendBtn || !voiceBtn) return;

  const hasText = inputEl.value.trim().length > 0;

  if (hasText) {
    voiceBtn.classList.add("hidden");
    voiceBtn.classList.remove("flex");

    sendBtn.classList.remove("hidden");
    sendBtn.classList.add("flex");
    sendBtn.disabled = false;
  } else {
    voiceBtn.classList.remove("hidden");
    voiceBtn.classList.add("flex");

    sendBtn.classList.add("hidden");
    sendBtn.classList.remove("flex");
    sendBtn.disabled = true;
  }
}

export function autoResizeInput() {
  const inputEl = document.getElementById("chat-input");
  if (!inputEl) return;

  inputEl.style.height = "auto";
  inputEl.style.height = `${inputEl.scrollHeight}px`;
}

export function clearInput() {
  const inputEl = document.getElementById("chat-input");

  if (!inputEl) return;

  inputEl.value = "";
  inputEl.style.height = "auto";
  inputEl.dispatchEvent(new Event("input"));
}

// ═══════════════════════════════════════════════════════════════
// Status indicators (thinking dots)
// ═══════════════════════════════════════════════════════════════

export function appendStatusIndicator(id, parentContainer = null) {
  const container = parentContainer || document.getElementById("chat-history");

  if (!container) return;

  // Inject the wave-dot keyframes once
  if (!document.getElementById("mindpal-dot-style")) {
    const style = document.createElement("style");
    style.id = "mindpal-dot-style";
    style.textContent = `
      @keyframes mindpal-wave {
        0%, 60%, 100% { transform: scaleY(0.5); opacity: 0.5; }
        30% { transform: scaleY(1.15); opacity: 1; }
      }
      .mp-dot {
        width: 5px;
        height: 14px;
        border-radius: 2px;
        background: linear-gradient(180deg, #4285f4, #9b72cb);
        display: inline-block;
        animation: mindpal-wave 1.1s ease-in-out infinite;
        transform-origin: center bottom;
      }
      .mp-dot:nth-child(1) { animation-delay: 0s; }
      .mp-dot:nth-child(2) { animation-delay: 0.18s; }
      .mp-dot:nth-child(3) { animation-delay: 0.36s; }
      @media (prefers-color-scheme: dark) {
        .mp-dot { background: linear-gradient(180deg, #7baaf7, #c58af9); }
      }
    `;
    document.head.appendChild(style);
  }

  const msgDiv = document.createElement("div");
  msgDiv.id = id;
  msgDiv.className = "flex w-full animate-fade-in py-1";
  msgDiv.innerHTML = `
    <div class="flex items-center gap-3">
      <div class="flex items-end gap-[3px]">
        <span class="mp-dot"></span>
        <span class="mp-dot"></span>
        <span class="mp-dot"></span>
      </div>
      <span class="text-[14px] font-medium text-[#444746] dark:text-[#c4c7c5]">Thinking...</span>
    </div>
  `;

  container.appendChild(msgDiv);
  scrollChatToBottom();
}

export function removeStatusIndicator(id) {
  document.getElementById(id)?.remove();
}

export function finalizeStatusIndicator(id, elapsedMs) {
  const el = document.getElementById(id);
  if (!el) return;

  const seconds = (elapsedMs / 1000).toFixed(1);

  const inner = el.querySelector(".flex.items-center");
  if (inner) {
    inner.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
        class="text-[#4285f4] dark:text-[#7baaf7] flex-shrink-0 mr-1 opacity-80">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      <span class="text-[13px] text-[#5f6368] dark:text-[#9aa0a6] italic">
        Thought for ${seconds}s
      </span>
    `;
  }
}

export function scrollChatToBottom(behavior = "auto", force = false) {
  requestAnimationFrame(() => {
    const chatHistory = document.getElementById("chat-history");
    if (chatHistory) {
      const isNearBottom = chatHistory.scrollHeight - chatHistory.scrollTop - chatHistory.clientHeight < 150;
      if (force || isNearBottom) {
        chatHistory.scrollTo({
          top: chatHistory.scrollHeight,
          behavior: behavior === "smooth" ? "smooth" : "auto"
        });
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// Toast & misc UI
// ═══════════════════════════════════════════════════════════════

export function showToast(message) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  container.querySelectorAll("[data-toast]").forEach((existing) => existing.remove());

  const toast = document.createElement("div");
  toast.dataset.toast = "true";
  toast.className = "flex items-center gap-2 px-4 py-3 rounded-2xl shadow-lg animate-toast pointer-events-auto bg-gray-900 dark:bg-white text-white dark:text-gray-900";
  toast.innerHTML = `<i data-lucide="info" class="w-4 h-4 opacity-80"></i><span class="text-sm font-medium">${escapeHtml(message)}</span>`;

  container.appendChild(toast);
  refreshIcons(toast);

  window.setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(1rem)";
    toast.style.transition = "all 0.3s ease-in";
    window.setTimeout(() => toast.remove(), 300);
  }, 3_000);
}

export function setButtonBusy(button, isBusy, loadingText = "Processing...") {
  if (!button) return;

  const textEl = button.querySelector(".btn-text");
  const iconEl = button.querySelector(".btn-icon") || button.querySelector("[data-lucide]");

  if (isBusy) {
    button.disabled = true;

    if (textEl) {
      button.dataset.originalText = textEl.textContent || "";
      textEl.textContent = loadingText;
    }

    if (iconEl) {
      button.dataset.originalIcon = iconEl.getAttribute("data-lucide") || "";
      iconEl.setAttribute("data-lucide", "loader-2");
      iconEl.classList.add("animate-spin");
    }
  } else {
    button.disabled = false;

    if (textEl && button.dataset.originalText) {
      textEl.textContent = button.dataset.originalText;
    }

    if (iconEl && button.dataset.originalIcon) {
      iconEl.setAttribute("data-lucide", button.dataset.originalIcon);
      iconEl.classList.remove("animate-spin");
    }
  }

  refreshIcons();
}

export function exportConversationLog() {
  if (state.chatMemory.length === 0) {
    showToast("No conversation to export.");
    return;
  }

  let fileContent = `MindPal Session Export\nDate: ${new Date().toLocaleString()}\n\n`;

  for (const message of state.chatMemory) {
    fileContent += `[${message.role}]\n${message.text}\n\n`;
  }

  const blob = new Blob([fileContent], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = `MindPal_Log_${Date.now()}.txt`;
  anchor.click();

  URL.revokeObjectURL(url);
  showToast("Log exported.");
}

// ═══════════════════════════════════════════════════════════════
// escapeHtml — exported for consumers (app.js, etc.)
// ═══════════════════════════════════════════════════════════════

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
