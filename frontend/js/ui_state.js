// frontend/js/ui_state.js

const STATE_KEY = "mindpal_state_v2";
const THEME_KEY = "mindpal_theme";

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

export function saveState() {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
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

export function addMessage(role, text, extra = {}) {
  const normalizedRole = role === "User" || role === "user" ? "User" : "MindPal";
  const cleanText = String(text || "").trim();

  if (!cleanText) return null;

  const message = {
    role: normalizedRole,
    text: cleanText,
    createdAt: new Date().toISOString(),
    ...extra,
  };

  state.chatMemory.push(message);

  if (normalizedRole === "User") {
    state.messageCount += 1;
  }

  saveState();
  return message;
}

export function replaceChatMemory(messages) {
  state.chatMemory = Array.isArray(messages) ? messages : [];
  state.messageCount = state.chatMemory.filter((item) => item.role === "User").length;
  saveState();
}

export function clearChatMemory() {
  state.chatMemory = [];
  state.messageCount = 0;
  saveState();
}

export function calculateStreak() {
  const today = new Date().toDateString();

  if (!Array.isArray(state.visitHistory)) {
    state.visitHistory = [];
  }

  if (state.lastVisitDate !== today) {
    if (state.lastVisitDate) {
      const previous = new Date(state.lastVisitDate);
      const now = new Date();
      const diffDays = Math.ceil(Math.abs(now - previous) / 86_400_000);

      state.streak = diffDays === 1 ? Number(state.streak || 0) + 1 : 1;
    } else {
      state.streak = 1;
    }

    state.lastVisitDate = today;

    if (!state.visitHistory.includes(today)) {
      state.visitHistory.push(today);
    }
  } else if (!state.visitHistory.includes(today)) {
    state.visitHistory.push(today);
  }

  updateStreakUI();
  return state.streak;
}

export function updateStreakUI() {
  const streakCounter = document.getElementById("streak-counter");
  const modalStreakCount = document.getElementById("modal-streak-count");

  const value = String(Number(state.streak || 0));

  if (streakCounter) {
    streakCounter.textContent = value;
  }

  if (modalStreakCount) {
    modalStreakCount.textContent = value;
  }
}

export function initializeTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;

  applyTheme(saved ? saved === "dark" : Boolean(prefersDark));
}

export function toggleTheme() {
  const willBeDark = !document.documentElement.classList.contains("dark");
  applyTheme(willBeDark);
  return willBeDark;
}

export function applyTheme(isDark) {
  document.documentElement.classList.toggle("dark", Boolean(isDark));
  localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");

  const themeIcon = document.getElementById("theme-icon");
  const modalThemeToggle = document.getElementById("modal-theme-toggle");

  if (themeIcon) {
    themeIcon.setAttribute("data-lucide", isDark ? "sun" : "moon");
  }

  if (modalThemeToggle) {
    modalThemeToggle.checked = Boolean(isDark);
  }

  refreshIcons();
}

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

  setGreeting();
  refreshIcons();
}

export function renderWeeklyTracker() {
  updateStreakUI();

  const countEl = document.getElementById("modal-streak-count");
  const tracker = document.getElementById("weekly-tracker");

  if (countEl) {
    countEl.textContent = String(Number(state.streak || 0));
  }

  if (!tracker) return;

  tracker.innerHTML = "";

  const days = ["S", "M", "T", "W", "T", "F", "S"];
  const today = new Date();

  for (let i = 6; i >= 0; i -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);

    const dateStr = date.toDateString();
    const isVisited = state.visitHistory.includes(dateStr);
    const isToday = i === 0;
    const label = isToday ? "Today" : days[date.getDay()];

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
          <div class="${circleClasses}">${iconHtml}</div>
        </div>
      `,
    );
  }

  refreshIcons();
}

export function openModal(modalId, contentId) {
  const modal = document.getElementById(modalId);
  const content = document.getElementById(contentId);

  modal?.classList.remove("opacity-0", "pointer-events-none");
  content?.classList.remove("scale-95");
}

export function closeModal(modalId, contentId) {
  const modal = document.getElementById(modalId);
  const content = document.getElementById(contentId);

  modal?.classList.add("opacity-0", "pointer-events-none");
  content?.classList.add("scale-95");
}

export function setChatStarted(started) {
  const welcomeScreen = document.getElementById("welcome-screen");
  const chatHistory = document.getElementById("chat-history");
  const interactionArea = document.getElementById("interaction-area");

  if (started) {
    welcomeScreen?.classList.add("hidden");

    chatHistory?.classList.remove("hidden");
    chatHistory?.classList.add("flex");

    interactionArea?.classList.remove("flex-1", "justify-center");
    interactionArea?.classList.add("flex-none", "justify-end", "pt-0");
  } else {
    welcomeScreen?.classList.remove("hidden");

    chatHistory?.classList.add("hidden");
    chatHistory?.classList.remove("flex");

    interactionArea?.classList.add("flex-1", "justify-center");
    interactionArea?.classList.remove("flex-none", "justify-end", "pt-0");
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

export function appendStatusIndicator(id) {
  const chatHistory = document.getElementById("chat-history");

  if (!chatHistory) return;

  const msgDiv = document.createElement("div");
  msgDiv.id = id;
  msgDiv.className = "flex w-full animate-fade-in pl-10";
  msgDiv.innerHTML = `<div class="text-[15px] font-medium shimmer-text">Thought for a few seconds...</div>`;

  chatHistory.appendChild(msgDiv);
  scrollChatToBottom("smooth");
}

export function removeStatusIndicator(id) {
  document.getElementById(id)?.remove();
}

export function scrollChatToBottom(behavior = "smooth") {
  const chatHistory = document.getElementById("chat-history");
  chatHistory?.scrollTo({ top: chatHistory.scrollHeight, behavior });
}

export function showToast(message) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = "flex items-center gap-2 px-4 py-3 rounded-2xl shadow-lg animate-toast pointer-events-auto bg-gray-900 dark:bg-white text-white dark:text-gray-900";
  toast.innerHTML = `<i data-lucide="info" class="w-4 h-4 opacity-80"></i><span class="text-sm font-medium">${escapeHtml(message)}</span>`;

  container.appendChild(toast);
  refreshIcons();

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

export function refreshIcons() {
  if (window.lucide?.createIcons) {
    window.lucide.createIcons();
  }
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeName(value) {
  const clean = String(value || "").trim();
  return clean || "Friend";
}

function cryptoRandomId() {
  if (window.crypto?.getRandomValues) {
    const bytes = new Uint8Array(8);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  return Math.random().toString(36).slice(2, 12);
}