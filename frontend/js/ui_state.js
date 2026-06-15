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
let iconRefreshFrame = null;
let deferredStateSaveTimer = null;

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
  
  // Only remove overflow-hidden if no other modals are open
  // In a simple app, we can just remove it, but to be safe we should check
  const anyModalOpen = document.querySelectorAll('.fixed.inset-0:not(.opacity-0)').length > 0;
  if (!anyModalOpen) {
    document.body.classList.remove("overflow-hidden");
  }
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
  msgDiv.className = "flex w-full animate-fade-in pl-4 sm:pl-10 py-1";
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

  // Stop the wave animation by swapping dots for a static checkmark-style icon
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
      // Only auto-scroll if we are near the bottom already, or if forced
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

function getLucideExportName(iconName) {
  return String(iconName || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function renderScopedIcons(root) {
  const lucide = window.lucide;
  const iconNodes = Array.from(root?.querySelectorAll?.("i[data-lucide]") || []);

  if (!lucide?.icons || iconNodes.length === 0) return true;

  let renderedCount = 0;

  for (const node of iconNodes) {
    const iconName = node.getAttribute("data-lucide");
    const iconDefinition = lucide.icons[iconName] || lucide.icons[getLucideExportName(iconName)];
    if (!iconDefinition) continue;

    const attrs = {
      class: node.getAttribute("class") || "",
      "aria-hidden": "true",
    };

    let svg = null;
    if (typeof iconDefinition.toSvg === "function") {
      const template = document.createElement("template");
      template.innerHTML = iconDefinition.toSvg(attrs).trim();
      svg = template.content.firstElementChild;
    } else if (typeof lucide.createElement === "function") {
      svg = lucide.createElement(iconDefinition, attrs);
    }

    if (svg) {
      node.replaceWith(svg);
      renderedCount += 1;
    }
  }

  return renderedCount === iconNodes.length;
}

export function refreshIcons(root = document) {
  if (!window.lucide?.createIcons) return;

  if (root !== document && renderScopedIcons(root)) {
    return;
  }

  if (iconRefreshFrame !== null) return;

  iconRefreshFrame = window.requestAnimationFrame(() => {
    iconRefreshFrame = null;
    window.lucide.createIcons();
  });
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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

function normalizeDayKeys(values) {
  if (!Array.isArray(values)) return [];

  const seen = new Set();
  const output = [];

  for (const value of values) {
    const key = normalizeDateKey(value);

    if (!key || seen.has(key)) continue;

    seen.add(key);
    output.push(key);
  }

  output.sort();
  return output;
}

function normalizeDateKey(value) {
  const raw = String(value || "").trim();

  if (!raw) return "";

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  const parsed = new Date(raw);

  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return getLocalDateKey(parsed);
}

function getLocalDateKey(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);

  if (Number.isNaN(value.getTime())) {
    return "";
  }

  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function parseLocalDateKey(dateKey) {
  const [year, month, day] = String(dateKey || "").split("-").map(Number);

  if (!year || !month || !day) {
    return new Date();
  }

  return new Date(year, month - 1, day);
}

function addDaysLocal(dateKey, deltaDays) {
  const date = parseLocalDateKey(dateKey);
  date.setDate(date.getDate() + Number(deltaDays || 0));
  return getLocalDateKey(date);
}

function computeCurrentStreak(activeDays, todayKey = getLocalDateKey()) {
  let cursor = todayKey;
  let count = 0;

  while (activeDays.has(cursor)) {
    count += 1;
    cursor = addDaysLocal(cursor, -1);
  }

  return count;
}

function getMostRecentActiveDate(activeDays) {
  const values = Array.from(activeDays || []).filter(Boolean).sort();
  return values.length ? values[values.length - 1] : null;
}

function getLast7Days(todayKey = getLocalDateKey()) {
  const labels = ["S", "M", "T", "W", "T", "F", "S"];
  const output = [];

  for (let offset = 6; offset >= 0; offset -= 1) {
    const key = addDaysLocal(todayKey, -offset);
    const date = parseLocalDateKey(key);

    output.push({
      key,
      label: labels[date.getDay()],
    });
  }

  return output;
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
