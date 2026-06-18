// frontend/js/app.js — Bootstrap, event bindings, and orchestration

import {
  API_BASE_URL,
  buildClientFallbackReply,
  deleteMemory,
  deleteMemoryGraphItem,
  getCurrentUserProfile,
  loadUserProfile,
  saveMemoryGraph,
  sendChatMessageStream,
  deleteCurrentCloudChat,
} from "./api.js";

import {
  authIsConfigured,
  getCurrentUser,
  getIdToken,
  signInWithGoogle,
  signOut,
} from "./auth.js";

import {
  addMessage,
  appendStatusIndicator,
  finalizeStatusIndicator,
  autoResizeInput,
  clearChatMemory,
  clearInput,
  closeModal,
  escapeHtml,
  exportConversationLog,
  getState,
  initializeTheme,
  loadState,
  openModal,
  patchState,
  refreshIcons,
  removeStatusIndicator,
  renderWeeklyTracker,
  updateMentalHealthUI,
  replaceChatMemory,
  scrollChatToBottom,
  setButtonBusy,
  setChatStarted,
  setCloudSyncEnabled,
  setCrisisMode,
  setGreeting,
  setInputState,
  setUserName,
  showToast,
  syncInputButtons,
  updateProfileUI,
  updateUsageUI,
  updateUsageFromMeta,
  registerSettingsStore,
  getStreakSnapshot,
} from "./ui_state.js";

import { initLiveVoice, startLiveVoice } from "./voice_live.js";

import {
  formatMarkdown,
  stripMarkdown,
  typewriteHTML,
  bindAccordion,
} from "./utils/dom.js";

import { processStructuredResponse, truncateRepetition } from "./utils/chat_helpers.js";
import { speakText, fallbackCopy, isSafetyLock, isCrisisReply, resolveLocale } from "./utils/tts.js";

import {
  applyVisualSettings,
  buildChatSettingsMetadata,
  getAppSettings,
  hydrateSettingsFromProfile,
  setAppSetting,
} from "./settings_store.js";

import {
  initSettingsUI,
  bindSettingsControls,
  bindSettingsChoiceEvents,
  bindKeyboardShortcuts,
  persistAppSettingsToCloud,
  notifyFromSetting,
  renderSettingsControls,
} from "./components/settings_ui.js";

import {
  initMemoryUI,
  renderMemoryInspector,
} from "./components/memory_inspector.js";

import {
  bindUnifiedSelector,
  getCurrentModel,
  getCurrentMode,
} from "./components/model_selector.js";

import {
  initNotifications,
  notifyResponseComplete,
} from "./components/notifications.js";

import {
  initUsageTracker,
  canSendMessage,
  recordMessage,
  syncFromBackend as syncUsageFromBackend,
  renderUsagePanel,
} from "./components/usage_tracker.js";

import {
  initFrontendAuth,
  cleanupAuth,
  hydrateCloudMemory,
  hydrateCloudChat,
  scheduleCloudMessageSync,
  replaceCloudChatSnapshotSafe,
  persistMemoryContextSafe,
  buildCloudProfileContext,
  formatCloudConnectErrorSafe,
  resetCloudState,
  getMemoryContext,
  setMemoryContext,
  getMemoryGraphContext,
  setMemoryGraphContext,
  getCurrentCloudProfileContext,
  setCurrentCloudProfileContext,
} from "./cloud_sync.js";

import {
  answerQuestionFromMemoryGraph,
  classifyAndStoreMemoryGraphFromMessage,
  createEmptyMemoryGraph,
  buildMemoryGraphLines,
  loadMemoryGraphContext,
  memoryGraphFromBackend,
  memoryGraphFromLegacyMemory,
  memoryGraphToBackend,
  mergeMemoryGraphs,
  saveMemoryGraphContext,
} from "./memory_graph.js";

import {
  answerQuestionFromMemory,
  classifyAndStoreMemoryFromMessage,
  createEmptyMemory,
  buildMemoryLines,
  loadMemoryContext,
  memoryFromBackendSummary,
  saveMemoryContext,
  mergeMemoryContexts,
} from "./memory_graph.js";

// ═══════════════════════════════════════════════════════════════
// App state
// ═══════════════════════════════════════════════════════════════

let isGenerating = false;
let isSessionLocked = false;
let activeStreamController = null;

let globalLoaderRemoved = false;
export function removeGlobalLoader() {
  if (globalLoaderRemoved) return;
  globalLoaderRemoved = true;
  // Cancel the HTML safety-net timer
  if (window.__mindpalLoaderTimer) {
    clearTimeout(window.__mindpalLoaderTimer);
    window.__mindpalLoaderTimer = null;
  }
  const loader = document.getElementById("global-loader");
  if (loader) {
    setTimeout(() => {
      loader.classList.add("opacity-0");
      setTimeout(() => loader.remove(), 700);
    }, 150);
  }
}

// ═══════════════════════════════════════════════════════════════
// Voice context provider
// ═══════════════════════════════════════════════════════════════

function buildVoiceContextProvider() {
  const memoryContext = getMemoryContext();
  const memoryGraphContext = getMemoryGraphContext();
  return {
    getUserProfile() {
      const user = getCurrentUser?.() || {};
      const name = user?.displayName || user?.name || memoryContext?.preferredName || memoryContext?.user?.preferredName || "";
      const comm = memoryContext?.communicationPreferences || {};
      return {
        name,
        preferences: {
          tone: comm.tone || "",
          language: comm.language || "",
          responseStyle: comm.responseStyle || [],
          avoid: comm.avoid || [],
        },
        communication: {
          avoidedResponses: memoryContext?.avoidedResponses || [],
          emotionalTriggers: memoryContext?.emotionalTriggers || [],
          userGoals: memoryContext?.userGoals || [],
        },
      };
    },
    getMemoryLines() {
      const legacy = buildMemoryLines(memoryContext);
      const graph = buildMemoryGraphLines(memoryGraphContext);
      const seen = new Set();
      const all = [];
      for (const line of [...graph, ...legacy]) {
        const key = line.toLowerCase().trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        all.push(line);
      }
      return all.slice(0, 30);
    },
    getRecentChat(count = 10) {
      const messages = getState().chatMemory || [];
      return messages.slice(-Math.min(count, 20));
    },
    searchChat(query) {
      const messages = getState().chatMemory || [];
      const q = String(query).toLowerCase();
      return messages.filter(m => String(m.text || "").toLowerCase().includes(q));
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Console banner
// ═══════════════════════════════════════════════════════════════

const consoleBanner = `
 __  __ _           _ ____       _ 
|  \\/  (_)_ __   __| |  _ \\ __ _| |
| |\\/| | | '_ \\ / _\` | |_) / _\` | |
| |  | | | | | | (_| |  __/ (_| | |
|_|  |_|_|_| |_|\\__,_|_|   \\__,_|_|
                                   
Welcome to the MindPal developer console!

⚠️ WARNING: This is a browser feature intended for developers.
If someone told you to copy-paste something here to enable a feature
or "hack" someone's account, it is a scam and will give them access
to your MindPal account.
`;
console.log("%c" + consoleBanner, "color: #3b82f6; font-weight: bold; font-family: monospace;");

// ═══════════════════════════════════════════════════════════════
// Bootstrap
// ═══════════════════════════════════════════════════════════════

document.addEventListener("DOMContentLoaded", bootstrap);

async function bootstrap() {
  try {
    refreshIcons();
    initializeTheme();
    registerSettingsStore({ setAppSetting });
    applyVisualSettings();
    loadState();

    await initFrontendAuth({
      removeGlobalLoader,
      renderPersistedChat,
      renderMemoryInspector,
    });

    initSettingsUI({
      refreshIcons,
      showToast,
      openModal,
      closeModal,
      startNewLocalChat,
      handleSend: () => handleSend(),
      getCurrentUser,
      updateProfileUI,
      get isGenerating() { return isGenerating; },
      get isSessionLocked() { return isSessionLocked; },
      get currentCloudProfileContext() { return getCurrentCloudProfileContext(); },
    });

    initMemoryUI({
      refreshIcons,
      deleteMemoryEntry,
      editMemoryEntry,
      toggleMemoryPin,
      clearMemoryCategory,
      persistMemoryContextSafe,
      getMemoryGraphContext,
    });

    bindTheme();
    bindProfileModal();
    bindSettingsTabs();
    bindSettingsControls();
    bindSettingsChoiceEvents();
    bindKeyboardShortcuts();
    bindStreakModal();
    bindSettings();
    bindInput();
    bindUnifiedSelector({ isSessionLocked: () => isSessionLocked });
    bindMoodButtons();
    bindConversationActions();

    initNotifications({ showToast, getStreakSnapshot });
    initUsageTracker({ showToast });

    initLiveVoice({
      onChatSync: (callData) => {
        const { userTranscript, aiTranscript, startTime, endTime, durationMs } = callData;
        if (!userTranscript && !aiTranscript) return;

        const totalSec = Math.round(durationMs / 1000);
        const mins = Math.floor(totalSec / 60);
        const secs = totalSec % 60;
        const durationStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

        const callMsg = addMessage("MindPal", `[Voice Call] ${durationStr}`, {
          type: "voice_call",
          voiceCall: { startTime, endTime, durationMs, durationStr, userTranscript, aiTranscript },
        });

        if (callMsg) {
          setChatStarted(true);
          insertCallCardUI({ startTime, durationStr, userTranscript, aiTranscript });
        }

        if (userTranscript) {
          let memoryGraphContext = getMemoryGraphContext();
          let memoryContext = getMemoryContext();

          const graphResult = classifyAndStoreMemoryGraphFromMessage(userTranscript, {
            graphContext: memoryGraphContext,
            source: "voice_call",
          });
          memoryGraphContext = graphResult.graph;
          setMemoryGraphContext(memoryGraphContext);
          saveMemoryGraphContext(memoryGraphContext);

          const memResult = classifyAndStoreMemoryFromMessage(userTranscript, {
            memoryContext,
            recentMessages: getState().chatMemory.slice(-8),
          });
          if (memResult.saved.length) {
            memoryContext = memResult.memory;
            setMemoryContext(memoryContext);
            saveMemoryContext(memoryContext);
          }
        }

        scrollChatToBottom("smooth", true);
      },
    });

    const mainVoiceBtn = document.getElementById("voice-btn");
    if (mainVoiceBtn) {
      mainVoiceBtn.addEventListener("click", () => {
        if (isGenerating || isSessionLocked) return;
        startLiveVoice(buildVoiceContextProvider());
      });
    }

    renderPersistedChat();
    updateProfileUI(getCurrentUser());
    setGreeting();
    setInputState({ disabled: false, locked: false });

    updateMentalHealthUI();
    renderWeeklyTracker();

    refreshIcons();

    if (!authIsConfigured()) {
      removeGlobalLoader();
    }
  } catch (error) {
    console.error("[MindPal] Bootstrap failed:", error);
    if (typeof showToast === 'function') {
      showToast("Critical error during startup. Please refresh the page.");
    }
    removeGlobalLoader();
  }
}

// ═══════════════════════════════════════════════════════════════
// Event bindings
// ═══════════════════════════════════════════════════════════════

function bindTheme() {
  document.getElementById("theme-toggle-btn")?.addEventListener("click", () => {
    const isDark = document.documentElement.classList.contains("dark");
    setAppSetting("appearance", isDark ? "light" : "dark");
    void persistAppSettingsToCloud();
  });
}

function bindProfileModal() {
  const profileModal = document.getElementById("profile-modal");
  const closeProfileBtn = document.getElementById("close-profile-btn");
  const closeProfileMobileBtn = document.getElementById("close-profile-mobile-btn");
  const connectBtn = document.getElementById("btn-cloud-connect");
  const disconnectBtn = document.getElementById("btn-cloud-disconnect");
  const userNameInput = document.getElementById("user-name-input");

  document.getElementById("profile-btn")?.addEventListener("click", () => {
    updateProfileUI(getCurrentUser());
    // Re-render settings controls so dropdowns reflect changes made outside the panel
    renderSettingsControls(document.getElementById("profile-content") || document);
    if (document.querySelector('[data-settings-panel="memory"]')?.classList.contains("active")) {
      renderMemoryInspector();
    }
    openModal("profile-modal", "profile-content");
  });

  closeProfileBtn?.addEventListener("click", () => closeModal("profile-modal", "profile-content"));
  closeProfileMobileBtn?.addEventListener("click", () => closeModal("profile-modal", "profile-content"));

  profileModal?.addEventListener("click", (event) => {
    if (event.target === profileModal) closeProfileBtn?.click();
  });

  connectBtn?.addEventListener("click", async () => {
    if (!authIsConfigured()) {
      showToast("Firebase web config is missing.");
      return;
    }

    setButtonBusy(connectBtn, true, "Connecting...");

    try {
      const user = await signInWithGoogle();
      if (!user) throw new Error("Firebase sign-in returned no user.");
      if (user.displayName) setUserName(user.displayName);

      const token = await getIdToken({ forceRefresh: true });
      if (!token) throw new Error("Firebase returned no ID token.");

      const profile = await getCurrentUserProfile(token);
      const storedProfile = await loadUserProfile(token).catch(() => null);
      if (storedProfile) {
        hydrateSettingsFromProfile(storedProfile);
        updateMentalHealthUI(storedProfile);
        updateUsageUI(storedProfile);
      }

      setCurrentCloudProfileContext({
        ...buildCloudProfileContext(user, profile),
        settingsMetadata: buildChatSettingsMetadata(),
      });
      await persistAppSettingsToCloud();
      await hydrateCloudMemory(token, renderMemoryInspector);
      await hydrateCloudChat(token, renderPersistedChat);

      setCloudSyncEnabled(true);
      updateProfileUI(user);
      showToast("Cloud profile connected.");
    } catch (error) {
      setCloudSyncEnabled(false);
      updateProfileUI(null);
      showToast(formatCloudConnectErrorSafe(error));
    } finally {
      setButtonBusy(connectBtn, false);
    }
  });

  disconnectBtn?.addEventListener("click", async () => {
    try { await signOut(); } catch {}
    resetCloudState();
    setCloudSyncEnabled(false);
    updateProfileUI(null);
    showToast("Signed out. Local mode enabled.");
  });

  userNameInput?.addEventListener("change", (event) => {
    const nextName = setUserName(event.target.value);
    let memoryContext = getMemoryContext();
    let memoryGraphContext = getMemoryGraphContext();

    memoryContext.preferredName = nextName === "Friend" ? "" : nextName;
    memoryContext.user.preferredName = memoryContext.preferredName;
    if (memoryContext.preferredName) {
      memoryGraphContext = mergeMemoryGraphs(memoryGraphContext, memoryGraphFromLegacyMemory(memoryContext));
      setMemoryGraphContext(memoryGraphContext);
    }
    setMemoryContext(memoryContext);
    saveMemoryGraphContext(memoryGraphContext);
    saveMemoryContext(memoryContext);
    void persistMemoryContextSafe();
    renderMemoryInspector();
    updateProfileUI(getCurrentUser());
    showToast(nextName === "Friend" ? "Profile name cleared." : "Profile updated.");
  });

  document.getElementById("delete-account-btn")?.addEventListener("click", async () => {
    const user = getCurrentUser();
    if (!user) { showToast("No cloud account is connected."); return; }

    const confirmed = await showCustomDialog({
      title: "Delete account",
      message: `This will permanently remove your cloud identity (${user.email || "unknown"}) and all synced data. This cannot be undone.`,
      confirmText: "Delete account",
      danger: true,
    });
    if (!confirmed) return;

    try {
      const token = await getIdToken();
      if (token) {
        await deleteMemory(token);
        await saveMemoryGraph(createEmptyMemoryGraph(), token);
        await deleteCurrentCloudChat(token);
      }
      await signOut();
    } catch (error) {
      console.warn("Account deletion failed:", error);
    }

    resetCloudState();
    clearChatMemory();
    setMemoryContext(saveMemoryContext(createEmptyMemory()));
    setMemoryGraphContext(saveMemoryGraphContext(createEmptyMemoryGraph()));
    renderMemoryInspector();
    document.getElementById("chat-history")?.replaceChildren();
    setChatStarted(false);
    setCloudSyncEnabled(false);
    updateProfileUI(null);
    closeModal("profile-modal", "profile-content");
    showToast("Account deleted and signed out.");
  });
}

function bindStreakModal() {
  const streakModal = document.getElementById("streak-modal");
  const closeStreakBtn = document.getElementById("close-streak-btn");

  document.getElementById("streak-btn")?.addEventListener("click", () => {
    renderWeeklyTracker();
    openModal("streak-modal", "streak-content");
  });

  closeStreakBtn?.addEventListener("click", () => closeModal("streak-modal", "streak-content"));

  streakModal?.addEventListener("click", (event) => {
    if (event.target === streakModal) closeStreakBtn?.click();
  });
}

function bindSettings() {
  document.getElementById("crisis-toggle")?.addEventListener("change", (event) => {
    setCrisisMode(event.target.checked);
    showToast(
      event.target.checked
        ? "Crisis UI interception enabled. Backend safety is always active."
        : "Crisis UI interception disabled. Backend safety is still active.",
    );
  });

  document.getElementById("memory-refresh-btn")?.addEventListener("click", async () => {
    const token = await getIdToken();
    if (token) {
      await hydrateCloudMemory(token, renderMemoryInspector);
      showToast("Memory refreshed.");
      return;
    }
    setMemoryContext(loadMemoryContext());
    setMemoryGraphContext(loadMemoryGraphContext());
    renderMemoryInspector();
    showToast("Local memory refreshed.");
  });
}

function bindSettingsTabs() {
  const buttons = Array.from(document.querySelectorAll("[data-settings-tab]"));
  const panels = Array.from(document.querySelectorAll("[data-settings-panel]"));
  const mobileSelect = document.getElementById("settings-mobile-tabs");

  const activate = (tab) => {
    const nextTab = tab || "general";
    buttons.forEach((button) => button.classList.toggle("active", button.getAttribute("data-settings-tab") === nextTab));
    panels.forEach((panel) => {
      const isActive = panel.getAttribute("data-settings-panel") === nextTab;
      panel.classList.toggle("active", isActive);
      panel.hidden = !isActive;
    });
    if (mobileSelect && mobileSelect.value !== nextTab) mobileSelect.value = nextTab;
    if (nextTab === "memory") renderMemoryInspector();
    if (nextTab === "usage") renderUsagePanel();
  };

  buttons.forEach((button) => button.addEventListener("click", () => activate(button.getAttribute("data-settings-tab") || "general")));
  mobileSelect?.addEventListener("change", (event) => activate(event.target.value));
  activate("general");
}

function startNewLocalChat() {
  if (activeStreamController) {
    activeStreamController.abort();
    activeStreamController = null;
  }
  isGenerating = false;

  clearChatMemory();
  document.getElementById("chat-history")?.replaceChildren();
  clearInput();
  setChatStarted(false);
  isSessionLocked = false;
  setInputState({ disabled: false, locked: false });
  showToast("New conversation started.");

  if (getCurrentUser()) {
    void replaceCloudChatSnapshotSafe([]);
  }
}

function bindInput() {
  const inputEl = document.getElementById("chat-input");
  const sendBtn = document.getElementById("send-btn");

  inputEl?.addEventListener("input", () => {
    autoResizeInput();
    syncInputButtons();
  });

  inputEl?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!isGenerating && !isSessionLocked) handleSend().catch(console.error);
    }
  });

  sendBtn?.addEventListener("click", () => {
    if (!isGenerating && !isSessionLocked) handleSend().catch(console.error);
  });
}

function bindMoodButtons() {
  document.querySelectorAll(".mood-btn").forEach((button) => {
    button.addEventListener("click", () => {
      if (isSessionLocked || isGenerating) return;

      const mood = String(button.getAttribute("data-mood") || "").toLowerCase();
      const inputEl = document.getElementById("chat-input");
      if (!inputEl || !mood) return;

      inputEl.value = `I'm feeling ${mood} right now.`;
      inputEl.dispatchEvent(new Event("input"));
      handleSend().catch(console.error);
    });
  });
}

function bindConversationActions() {
  document.getElementById("export-chat-btn")?.addEventListener("click", () => exportConversationLog());

  document.getElementById("clear-chat-btn")?.addEventListener("click", async () => {
    const confirmed = await showCustomDialog({
      title: "Delete all chats and memory",
      message: "This will clear your local conversation cache and cloud memory if signed in. This action cannot be undone.",
      confirmText: "Delete all",
      danger: true,
    });
    if (!confirmed) return;

    try {
      const token = await getIdToken();
      if (token) {
        await deleteMemory(token);
        await saveMemoryGraph(createEmptyMemoryGraph(), token);
        await deleteCurrentCloudChat(token);
      }
    } catch {}

    clearChatMemory();
    setMemoryContext(saveMemoryContext(createEmptyMemory()));
    setMemoryGraphContext(saveMemoryGraphContext(createEmptyMemoryGraph()));
    renderMemoryInspector();
    document.getElementById("chat-history")?.replaceChildren();
    setChatStarted(false);
    showToast("Memory cleared.");
  });
}

// ═══════════════════════════════════════════════════════════════
// Memory helpers
// ═══════════════════════════════════════════════════════════════

async function deleteMemoryEntry(atomId) {
  if (!atomId) return;

  const confirmed = await showCustomDialog({
    title: "Delete memory",
    message: "Are you sure you want to delete this memory? This cannot be undone.",
    confirmText: "Delete",
    danger: true,
  });
  if (!confirmed) return;

  let memoryGraphContext = getMemoryGraphContext();
  const now = new Date().toISOString();
  memoryGraphContext.atoms = (memoryGraphContext.atoms || []).map((atom) =>
    atom.id === atomId
      ? { ...atom, status: "deleted", pinned: false, updated_at: now, metadata: { ...(atom.metadata || {}), deleted_by_user: true } }
      : atom,
  );
  setMemoryGraphContext(memoryGraphContext);
  saveMemoryGraphContext(memoryGraphContext);

  const token = await getIdToken();
  if (token) {
    await deleteMemoryGraphItem(atomId, token).catch(() => {});
  }

  showToast("Memory entry deleted.");
}

function showCustomDialog({ title = "Confirm", message = "", input = false, defaultValue = "", confirmText = "Confirm", danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm";
    overlay.style.animation = "fadeIn 0.2s ease";

    const dangerClasses = danger
      ? "bg-rose-600 hover:bg-rose-700 text-white"
      : "bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-100";

    overlay.innerHTML = `
      <div class="bg-white dark:bg-[#1e1f20] rounded-2xl shadow-2xl max-w-md w-[90%] p-6" style="animation: scaleIn 0.25s ease">
        <h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-2">${escapeHtml(title)}</h3>
        <p class="text-sm text-gray-600 dark:text-gray-300 mb-5">${escapeHtml(message)}</p>
        ${input ? `<input id="custom-dialog-input" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-transparent text-gray-900 dark:text-white text-sm mb-5 focus:outline-none focus:ring-2 focus:ring-blue-500" value="${escapeHtml(defaultValue)}" autofocus>` : ""}
        <div class="flex gap-3">
          <button id="custom-dialog-cancel" class="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 rounded-xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Cancel</button>
          <button id="custom-dialog-confirm" class="flex-1 px-4 py-2.5 text-sm font-medium rounded-xl transition-colors ${dangerClasses}">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = (result) => {
      overlay.remove();
      resolve(result);
    };

    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
    document.getElementById("custom-dialog-cancel")?.addEventListener("click", () => close(false));
    document.getElementById("custom-dialog-confirm")?.addEventListener("click", () => {
      if (input) {
        close(document.getElementById("custom-dialog-input")?.value ?? defaultValue);
      } else {
        close(true);
      }
    });
  });
}

async function editMemoryEntry(atomId) {
  if (!atomId) return;
  let memoryGraphContext = getMemoryGraphContext();
  const atom = (memoryGraphContext.atoms || []).find((a) => a.id === atomId);
  if (!atom) { showToast("Memory entry not found."); return; }

  const newValue = await showCustomDialog({
    title: "Edit memory",
    message: `Editing: ${atom.value || ""}`,
    input: true,
    defaultValue: atom.value || "",
    confirmText: "Save",
  });

  if (newValue === false || newValue === null) return;

  const clean = String(newValue).trim();
  if (!clean) { showToast("Cannot save empty memory."); return; }

  memoryGraphContext.atoms = (memoryGraphContext.atoms || []).map((a) =>
    a.id === atomId ? { ...a, value: clean, updated_at: new Date().toISOString() } : a,
  );
  setMemoryGraphContext(memoryGraphContext);
  saveMemoryGraphContext(memoryGraphContext);
  showToast("Memory updated.");
}

function toggleMemoryPin(atomId) {
  if (!atomId) return;
  let memoryGraphContext = getMemoryGraphContext();
  memoryGraphContext.atoms = (memoryGraphContext.atoms || []).map((atom) =>
    atom.id === atomId ? { ...atom, pinned: !atom.pinned, updated_at: new Date().toISOString() } : atom,
  );
  setMemoryGraphContext(memoryGraphContext);
  saveMemoryGraphContext(memoryGraphContext);
}

function clearMemoryCategory(category) {
  if (!category) return;
  let memoryGraphContext = getMemoryGraphContext();
  const now = new Date().toISOString();
  memoryGraphContext.atoms = (memoryGraphContext.atoms || []).map((atom) =>
    atom.category === category && atom.status !== "deleted"
      ? { ...atom, status: "deleted", pinned: false, updated_at: now, metadata: { ...(atom.metadata || {}), deleted_by_user: true } }
      : atom,
  );
  setMemoryGraphContext(memoryGraphContext);
  saveMemoryGraphContext(memoryGraphContext);
  showToast("Memory category cleared.");
}

// ═══════════════════════════════════════════════════════════════
// handleSend — main chat orchestrator
// ═══════════════════════════════════════════════════════════════

async function handleSend() {
  const inputEl = document.getElementById("chat-input");
  const text = inputEl?.value?.trim() || "";
  if (!text || isGenerating || isSessionLocked) return;

  // ── Pre-flight usage check — block BEFORE any API call ──
  const currentModel = getCurrentModel();
  if (!canSendMessage(currentModel)) {
    showToast("You've reached your usage limit. Please wait for it to reset.", "warning");
    return;
  }

  isGenerating = true;
  setInputState({ disabled: true, locked: false });
  setChatStarted(true);

  let streamMsgDiv = null;
  const statusId = `status-${Date.now()}`;
  let streamResponseStr = "";
  let firstChunkReceived = false;

  try {
    await appendMessageToUI(text, "user", { smoothScroll: true });

    const userMessageRecord = addMessage("User", text);
    scheduleCloudMessageSync(userMessageRecord);
    clearInput();

    let memoryContext = getMemoryContext();
    let memoryGraphContext = getMemoryGraphContext();

    const recentMessages = getState().chatMemory.slice(-8);
    const memoryResult = classifyAndStoreMemoryFromMessage(text, { memoryContext, recentMessages });
    const graphResult = classifyAndStoreMemoryGraphFromMessage(text, { graphContext: memoryGraphContext });

    memoryContext = memoryResult.memory;
    memoryGraphContext = graphResult.graph;
    setMemoryContext(memoryContext);
    setMemoryGraphContext(memoryGraphContext);

    if (memoryResult.saved.length || graphResult.saved.length) {
      renderMemoryInspector();
      void persistMemoryContextSafe();
    }

    const localMemoryReply = graphResult.localReply || memoryResult.localReply;
    if ((graphResult.shouldIntercept || memoryResult.shouldIntercept) && localMemoryReply) {
      const memoryReplyRecord = addMessage("MindPal", localMemoryReply, { providerUsed: "local_memory", memoryUpdated: true });
      scheduleCloudMessageSync(memoryReplyRecord);
      await appendMessageToUI(localMemoryReply, "bot", { smoothScroll: true, typewriter: true });
      return;
    }

    const memoryDirectAnswer = answerQuestionFromMemoryGraph(text, memoryGraphContext) || answerQuestionFromMemory(text, memoryContext);
    if (memoryDirectAnswer) {
      const memoryAnswerRecord = addMessage("MindPal", memoryDirectAnswer, { providerUsed: "local_memory", memoryUsed: true });
      scheduleCloudMessageSync(memoryAnswerRecord);
      await appendMessageToUI(memoryDirectAnswer, "bot", { smoothScroll: true, typewriter: true });
      return;
    }

    const chatHistory = document.getElementById("chat-history");
    streamMsgDiv = document.createElement("div");
    streamMsgDiv.className = "flex flex-col gap-1 w-full self-start animate-fade-in pl-4 sm:pl-10 pr-2 sm:pr-4";
    if (chatHistory) chatHistory.appendChild(streamMsgDiv);

    appendStatusIndicator(statusId, streamMsgDiv);

    let contentBox = null;
    const state = getState();
    const token = await getIdToken();
    const mode = getCurrentMode();
    const model = getCurrentModel();
    const contentContainer = document.createElement("div");
    contentContainer.className = "flex flex-col text-[15px] text-gemini-text dark:text-gemini-darkText leading-relaxed max-w-3xl w-full pr-2 sm:pr-0";
    contentBox = document.createElement("div");
    contentBox.className = "content-box";
    contentBox.setAttribute("dir", "auto");
    contentContainer.appendChild(contentBox);
    streamMsgDiv.appendChild(contentContainer);
    scrollChatToBottom("auto", true);
    let backendMetaFinal = null;

    let lastRenderTime = 0;
    let renderTimeout = null;
    const streamStartTime = performance.now();
    let earlyAssistantMessage = null;

    if (activeStreamController) {
      activeStreamController.abort();
    }
    activeStreamController = new AbortController();

    await sendChatMessageStream({
      message: text,
      history: state.chatMemory,
      locale: resolveLocale(getAppSettings),
      mode,
      model,
      token,
      signal: activeStreamController.signal,
      profileContext: {
        ...(getCurrentCloudProfileContext() || {}),
        settingsMetadata: buildChatSettingsMetadata(),
      },
      onChunk: (chunkText) => {
        streamResponseStr += chunkText;

        // Finalize the "Thinking..." indicator when the response delimiter appears
        if (!firstChunkReceived) {
          const hasDelimiter = /\*{2}\s*(?:Response|Balanced\s*Reframe)\s*:?\s*\*{2}/i.test(streamResponseStr)
            || /(?:\n|^)\s*(?:Response|Balanced\s*Reframe)\s*:\s*/i.test(streamResponseStr);
          if (hasDelimiter) {
            firstChunkReceived = true;
            finalizeStatusIndicator(statusId, performance.now() - streamStartTime);
          }
        }

        const now = performance.now();
        if (now - lastRenderTime > 150) {
          lastRenderTime = now;
          if (renderTimeout) { cancelAnimationFrame(renderTimeout); renderTimeout = null; }
          contentBox.innerHTML = processStructuredResponse(streamResponseStr).finalHtml;
          scrollChatToBottom("auto");
        } else if (!renderTimeout) {
          renderTimeout = requestAnimationFrame(() => {
            renderTimeout = null;
            lastRenderTime = performance.now();
            contentBox.innerHTML = processStructuredResponse(streamResponseStr).finalHtml;
            scrollChatToBottom("auto");
          });
        }
      },
      onStatus: (status) => {
        if (status === "text_finished") {
          if (renderTimeout) { cancelAnimationFrame(renderTimeout); renderTimeout = null; }
          const elapsedMs = performance.now() - streamStartTime;
          const finalParsed = processStructuredResponse(streamResponseStr, elapsedMs);

          // Safety net: never show empty content box when we have text
          if (!finalParsed.finalHtml && streamResponseStr.trim()) {
            // Parser couldn't extract anything — show raw text stripped of internal markers
            let raw = streamResponseStr.trim()
              .replace(/^\s*\*{0,2}\s*Thought\s*:?\s*\*{0,2}\s*/i, "")
              .replace(/^\s*Self\s*:\s*/i, "")
              .replace(/^\s*REVIEW\s*:\s*/i, "")
              .trim();
            // Strip numbered step lines (1. INTAKE: ..., etc.)
            raw = raw.replace(/(?:^|\n)\s*[1-6][\.\)]\s*[A-Z][A-Z\s]*:[^\n]*/gi, "").trim();
            contentBox.innerHTML = raw
              ? `<div class="text-[15px] leading-relaxed mb-4" dir="auto">${formatMarkdown(raw)}</div>`
              : `<div class="text-[15px] leading-relaxed mb-4 text-gray-400 italic">Response could not be parsed. Please try again.</div>`;
          } else {
            contentBox.innerHTML = finalParsed.finalHtml;
          }

          if (finalParsed.timelineHtml) {
            const timelineDiv = document.createElement("div");
            timelineDiv.innerHTML = finalParsed.timelineHtml;
            contentContainer.insertBefore(timelineDiv, contentBox);
            document.getElementById(statusId)?.remove();
          } else {
            // No thought accordion — finalize indicator as "Thought for Xs" or remove it
            if (!firstChunkReceived) {
              finalizeStatusIndicator(statusId, elapsedMs);
            }
          }

          scrollChatToBottom("auto");
          isGenerating = false;
          notifyResponseComplete();
          setInputState({ disabled: false, locked: isSessionLocked });
          document.getElementById("chat-input")?.focus();

          const replyText = streamResponseStr.trim();
          earlyAssistantMessage = addMessage("MindPal", replyText, {
            requestId: null, providerUsed: null, safety: null,
            ragUsed: [], memoryUpdated: false, generationTimeMs: elapsedMs,
          });

          notifyFromSetting("responseComplete", "MindPal response ready", "MindPal finished the response.");

          if (!isCrisisReply(replyText, "")) {
            contentContainer.appendChild(buildMessageActions(replyText));
            refreshIcons();
          }
        }
      },
      onMetadata: (meta) => {
        backendMetaFinal = meta;
        if (meta.quota_exceeded) {
          showToast("MindPal Pro usage limit reached. Switched to Standard.", "warning");
          document.querySelector('.model-option[data-model="standard"]')?.click();
        }
        if (meta.pro_usage) updateUsageFromMeta(meta.pro_usage);
        if (meta.usage) syncUsageFromBackend(meta.usage);
      },
    });

    const reply = truncateRepetition(streamResponseStr.trim()) || streamResponseStr.trim();
    if (!reply) throw new Error("Backend returned empty reply.");

    // Record message credit (client-side tracking for guests)
    recordMessage(getCurrentModel());

    if (isSafetyLock(backendMetaFinal)) {
      isSessionLocked = true;
    }

    let assistantMessageRecord = earlyAssistantMessage;
    if (assistantMessageRecord) {
      assistantMessageRecord.text = reply;
      assistantMessageRecord.requestId = backendMetaFinal?.request_id || null;
      assistantMessageRecord.providerUsed = backendMetaFinal?.provider_used || null;
      assistantMessageRecord.safety = backendMetaFinal?.safety || null;
      assistantMessageRecord.ragUsed = backendMetaFinal?.rag_used || [];
      assistantMessageRecord.memoryUpdated = Boolean(backendMetaFinal?.memory_updated);
    } else {
      assistantMessageRecord = addMessage("MindPal", reply, {
        requestId: backendMetaFinal?.request_id || null,
        providerUsed: backendMetaFinal?.provider_used || null,
        safety: backendMetaFinal?.safety || null,
        ragUsed: backendMetaFinal?.rag_used || [],
        memoryUpdated: Boolean(backendMetaFinal?.memory_updated),
      });
    }

    scheduleCloudMessageSync(assistantMessageRecord);
    handleBackendMemoryUpdates(backendMetaFinal);

    const safetyLevel = backendMetaFinal?.safety?.level || backendMetaFinal?.safety?.user_visible_category || "";
    if (isCrisisReply(reply, safetyLevel)) {
      contentContainer.className = "flex flex-col text-[15px] text-rose-700 dark:text-rose-400 font-medium leading-relaxed max-w-3xl w-full pr-2 sm:pr-0";
      contentContainer.querySelector(".action-buttons")?.remove();
    }

    if (window.MINDPAL_CONFIG?.SHOW_RESPONSE_DEBUG && backendMetaFinal) {
      const metaEl = buildBackendMeta(backendMetaFinal);
      if (metaEl) contentContainer.appendChild(metaEl);
    }

    bindAccordion(streamMsgDiv);
    refreshIcons();
  } catch (error) {
    if (error?.name === "AbortError") {
      if (streamMsgDiv) streamMsgDiv.remove();
      return;
    }
    console.error("handleSend error:", error);
    if (!streamResponseStr.trim() && streamMsgDiv) streamMsgDiv.remove();
    if (!firstChunkReceived) removeStatusIndicator(statusId);

    const fallback = buildClientFallbackReply(error);
    const fallbackRecord = addMessage("MindPal", fallback, { providerUsed: "client_fallback", errorCode: error?.code || "frontend_error" });
    scheduleCloudMessageSync(fallbackRecord);

    try {
      await appendMessageToUI(fallback, "bot", { smoothScroll: true, typewriter: true });
    } catch (renderError) {
      console.error("Failed to render fallback message:", renderError);
    }
    notifyFromSetting("responseComplete", "MindPal response ready", "MindPal finished the fallback response.");
  } finally {
    isGenerating = false;
    setInputState({ disabled: false, locked: isSessionLocked });
    if (!isSessionLocked) document.getElementById("chat-input")?.focus();
    updateProfileUI(getCurrentUser());
  }
}

function handleBackendMemoryUpdates(meta) {
  if (!meta) return;
  let memoryContext = getMemoryContext();
  let memoryGraphContext = getMemoryGraphContext();

  if (meta.memory_summary) {
    memoryContext = saveMemoryContext(mergeMemoryContexts(memoryContext, memoryFromBackendSummary(meta.memory_summary)));
    setMemoryContext(memoryContext);
  }

  if (meta.memory_graph_snapshot && meta.memory_graph_full_snapshot) {
    memoryGraphContext = saveMemoryGraphContext(memoryGraphFromBackend(meta.memory_graph_snapshot));
    setMemoryGraphContext(memoryGraphContext);
  } else if (meta.memory_graph_delta) {
    memoryGraphContext = saveMemoryGraphContext(mergeMemoryGraphs(memoryGraphContext, memoryGraphFromBackend(meta.memory_graph_delta)));
    setMemoryGraphContext(memoryGraphContext);
  }

  if (meta.memory_summary || meta.memory_graph_snapshot || meta.memory_graph_delta) {
    renderMemoryInspector();
  }
}

// ═══════════════════════════════════════════════════════════════
// Chat rendering
// ═══════════════════════════════════════════════════════════════

function renderPersistedChat() {
  const state = getState();
  if (!state.chatMemory.length) { setChatStarted(false); return; }

  setChatStarted(true);
  const chatHistory = document.getElementById("chat-history");
  if (!chatHistory) return;
  chatHistory.innerHTML = "";

  for (const message of state.chatMemory) {
    if (message.type === "voice_call" && message.voiceCall) {
      insertCallCardUI({
        startTime: message.voiceCall.startTime,
        durationStr: message.voiceCall.durationStr,
        userTranscript: message.voiceCall.userTranscript,
        aiTranscript: message.voiceCall.aiTranscript,
        summary: message.voiceCall.summary || null,
      });
      continue;
    }
    if (message.text && message.text.startsWith("[Voice Call]")) {
      const durationMatch = message.text.match(/\[Voice Call\]\s*(.+)/);
      insertCallCardUI({
        startTime: message.createdAt || new Date().toISOString(),
        durationStr: durationMatch ? durationMatch[1].trim() : "",
        userTranscript: "",
        aiTranscript: "",
        summary: message.voiceCall?.summary || null,
      });
      continue;
    }
    appendMessageToUI(message.text, message.role === "User" ? "user" : "bot", {
      smoothScroll: false, typewriter: false, backendMeta: message,
    });
  }

  scrollChatToBottom("auto", true);
}

function insertCallCardUI({ startTime, durationStr, userTranscript, aiTranscript, summary: existingSummary }) {
  const chatHistory = document.getElementById("chat-history");
  if (!chatHistory) return;

  const callTime = new Date(startTime);
  const timeStr = callTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dateStr = callTime.toLocaleDateString([], { month: "short", day: "numeric" });
  const cardId = "call-card-" + Date.now() + Math.random().toString(36).slice(2, 6);
  const summaryId = cardId + "-summary";

  const card = document.createElement("div");
  card.className = "call-card-container w-full flex flex-col items-center my-4 opacity-70";
  card.innerHTML = `
    <div class="flex items-center justify-center w-full">
      <div class="h-px bg-gray-300 dark:bg-gray-700 flex-grow max-w-[100px]"></div>
      <span class="text-xs text-gray-500 dark:text-gray-400 px-3 tracking-wide flex items-center gap-1.5">
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
        </svg>
        Call ended · ${durationStr}
      </span>
      <div class="h-px bg-gray-300 dark:bg-gray-700 flex-grow max-w-[100px]"></div>
    </div>
    <div class="call-summary-row flex items-start gap-1 mt-1.5 cursor-pointer select-none max-w-sm w-full justify-center">
      <p id="${summaryId}" class="text-[11px] text-gray-400 dark:text-gray-500 leading-relaxed text-center">${(existingSummary && existingSummary.length <= 120) ? escapeHtml(existingSummary) : '<span class="italic">Summarizing…</span>'}</p>
      <svg class="w-2.5 h-2.5 text-gray-400 dark:text-gray-500 transition-transform duration-200 call-chevron mt-0.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </div>
    <div id="${cardId}" class="call-card-details hidden mt-1 text-[10px] text-gray-400 dark:text-gray-500">
      ${dateStr}, ${timeStr} · ${durationStr}
    </div>
  `;

  chatHistory.appendChild(card);

  const summaryRow = card.querySelector(".call-summary-row");
  const details = card.querySelector(`#${cardId}`);
  const chevron = card.querySelector(".call-chevron");

  summaryRow.addEventListener("click", () => {
    const isOpen = !details.classList.contains("hidden");
    details.classList.toggle("hidden");
    chevron.style.transform = isOpen ? "" : "rotate(180deg)";
  });

  const needsSummary = !existingSummary || existingSummary.length > 120;
  if (needsSummary && (userTranscript || aiTranscript)) {
    summarizeCallTranscript(userTranscript, aiTranscript).then(summary => {
      const summaryEl = document.getElementById(summaryId);
      if (summaryEl) summaryEl.textContent = summary;
      const state = getState();
      const callMsg = state.chatMemory.findLast?.(m => m.type === "voice_call" && m.voiceCall?.startTime === startTime);
      if (callMsg) {
        callMsg.voiceCall.summary = summary;
        patchState({ chatMemory: state.chatMemory });
      }
    }).catch(() => {
      const summaryEl = document.getElementById(summaryId);
      if (summaryEl) summaryEl.textContent = "Voice call";
    });
  }
}

async function summarizeCallTranscript(userTranscript, aiTranscript) {
  try {
    const token = await getIdToken().catch(() => null);
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_BASE_URL}/voice/summarize`, {
      method: "POST",
      headers,
      body: JSON.stringify({ user_transcript: userTranscript || "", ai_transcript: aiTranscript || "" }),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    return data.summary || "Voice call";
  } catch {
    return "Voice call";
  }
}

async function appendMessageToUI(text, sender, { smoothScroll = true, typewriter = false, backendMeta = null } = {}) {
  const chatHistory = document.getElementById("chat-history");
  if (!chatHistory) return;

  const msgDiv = document.createElement("div");

  if (sender === "user") {
    msgDiv.className = "flex justify-end w-full animate-fade-in pl-4 sm:pl-10 pr-2 sm:pr-4";
    msgDiv.innerHTML = `
      <div class="bg-gemini-surface dark:bg-gemini-darkSurface text-gemini-text dark:text-gemini-darkText px-5 py-3 rounded-[24px] max-w-[80%] text-[15px] leading-relaxed" dir="auto">
        ${escapeHtml(text)}
      </div>
    `;
    chatHistory.appendChild(msgDiv);
    if (smoothScroll) scrollChatToBottom("auto", true);
    return;
  }

  const safetyLevel = backendMeta?.safety?.level || backendMeta?.safety?.user_visible_category || "";
  const isCrisis = isCrisisReply(text, safetyLevel);
  const parsed = processStructuredResponse(text, backendMeta?.generationTimeMs || null);

  msgDiv.className = "flex flex-col gap-1 w-full self-start animate-fade-in pl-4 sm:pl-10 pr-2 sm:pr-4";

  const contentContainer = document.createElement("div");
  contentContainer.className = `flex flex-col text-[15px] ${isCrisis ? "text-rose-700 dark:text-rose-400 font-medium" : "text-gemini-text dark:text-gemini-darkText"} leading-relaxed max-w-3xl w-full pr-2 sm:pr-0`;

  if (parsed.timelineHtml) {
    const timelineDiv = document.createElement("div");
    timelineDiv.innerHTML = parsed.timelineHtml;
    contentContainer.appendChild(timelineDiv);
  }

  const contentBox = document.createElement("div");
  contentBox.className = "content-box";
  contentBox.setAttribute("dir", "auto");

  // Static "Thought for Xs" fallback when no accordion but timing data exists
  if (!parsed.timelineHtml && backendMeta?.generationTimeMs) {
    const timeSec = (backendMeta.generationTimeMs / 1000).toFixed(1);
    const staticDiv = document.createElement("div");
    staticDiv.innerHTML = `
      <div class="flex items-center gap-1 mb-2">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
          class="text-[#4285f4] dark:text-[#7baaf7] flex-shrink-0 opacity-80">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        <span class="text-[13px] text-[#5f6368] dark:text-[#9aa0a6] italic">Thought for ${timeSec}s</span>
      </div>
    `;
    contentContainer.appendChild(staticDiv);
  }

  if (!typewriter) contentBox.innerHTML = parsed.finalHtml;
  contentContainer.appendChild(contentBox);
  if (!isCrisis) contentContainer.appendChild(buildMessageActions(text));

  if (window.MINDPAL_CONFIG?.SHOW_RESPONSE_DEBUG && backendMeta) {
    const metaEl = buildBackendMeta(backendMeta);
    if (metaEl) contentContainer.appendChild(metaEl);
  }

  msgDiv.appendChild(contentContainer);
  chatHistory.appendChild(msgDiv);
  bindAccordion(msgDiv);
  refreshIcons();

  if (typewriter) {
    await typewriteHTML(contentBox, parsed.finalHtml, chatHistory);
    contentContainer.querySelector(".action-buttons")?.classList.remove("opacity-0");
  }

  if (smoothScroll) scrollChatToBottom("auto");
}

function buildMessageActions(text) {
  const actionDiv = document.createElement("div");
  actionDiv.className = "flex items-center gap-1 mt-3 text-gray-500 dark:text-[#c4c7c5] action-buttons transition-opacity duration-300 opacity-100";

  actionDiv.innerHTML = `
    <button class="action-play p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors" title="Read aloud">
      <i data-lucide="volume-2" class="w-[15px] h-[15px]"></i>
    </button>
    <button class="action-copy p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors" title="Copy text">
      <i data-lucide="copy" class="w-[15px] h-[15px]"></i>
    </button>
    <button class="action-like p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors" title="Good response">
      <i data-lucide="thumbs-up" class="w-[15px] h-[15px]"></i>
    </button>
    <button class="action-dislike p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors" title="Bad response">
      <i data-lucide="thumbs-down" class="w-[15px] h-[15px]"></i>
    </button>
    <button class="action-retry p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors" title="Regenerate">
      <i data-lucide="rotate-cw" class="w-[15px] h-[15px]"></i>
    </button>
  `;

  const playBtn = actionDiv.querySelector(".action-play");
  playBtn?.addEventListener("click", () => speakText(stripMarkdown(text), playBtn, { showToast }));

  actionDiv.querySelector(".action-copy")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(stripMarkdown(text));
      showToast("Copied to clipboard.");
    } catch {
      fallbackCopy(stripMarkdown(text));
      showToast("Copied to clipboard.");
    }
  });

  const likeBtn = actionDiv.querySelector(".action-like");
  const dislikeBtn = actionDiv.querySelector(".action-dislike");
  likeBtn?.addEventListener("click", () => {
    likeBtn.classList.toggle("text-blue-600");
    likeBtn.classList.toggle("dark:text-blue-400");
    dislikeBtn?.classList.remove("text-red-600", "dark:text-red-400");
  });
  dislikeBtn?.addEventListener("click", () => {
    dislikeBtn.classList.toggle("text-red-600");
    dislikeBtn.classList.toggle("dark:text-red-400");
    likeBtn?.classList.remove("text-blue-600", "dark:text-blue-400");
  });

  actionDiv.querySelector(".action-retry")?.addEventListener("click", () => regenerateLastUserMessage(text).catch(console.error));

  return actionDiv;
}

async function regenerateLastUserMessage(targetAssistantText = "") {
  if (isGenerating || isSessionLocked) return;

  const state = getState();
  const messages = Array.isArray(state.chatMemory) ? state.chatMemory : [];
  if (messages.length < 2) { showToast("Nothing to regenerate."); return; }

  const cleanTarget = String(targetAssistantText || "").trim();
  let assistantIndex = -1;

  if (cleanTarget) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "MindPal" && String(messages[i]?.text || "").trim() === cleanTarget) {
        assistantIndex = i;
        break;
      }
    }
  }
  if (assistantIndex < 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "MindPal") { assistantIndex = i; break; }
    }
  }
  if (assistantIndex < 0) { showToast("No assistant response to regenerate."); return; }

  let userIndex = assistantIndex - 1;
  while (userIndex >= 0 && messages[userIndex]?.role !== "User") userIndex--;
  if (userIndex < 0) { showToast("No matching user message found."); return; }

  const userMessage = String(messages[userIndex]?.text || "").trim();
  if (!userMessage) { showToast("No matching user message found."); return; }

  isGenerating = true;
  setInputState({ disabled: true, locked: false });
  setChatStarted(true);

  const statusId = `status-regenerate-${Date.now()}`;
  let streamResponseStr = "";
  let streamMsgDiv = null;
  let firstChunkReceived = false;

  try {
    const preservedMessages = messages.slice(0, assistantIndex);
    replaceChatMemory(preservedMessages);
    renderPersistedChat();
    void replaceCloudChatSnapshotSafe(preservedMessages);
    const token = await getIdToken();
    const mode = getCurrentMode();
    const chatHistory = document.getElementById("chat-history");
    streamMsgDiv = document.createElement("div");
    streamMsgDiv.className = "flex flex-col gap-1 w-full self-start animate-fade-in pl-4 sm:pl-10 pr-2 sm:pr-4";
    if (chatHistory) chatHistory.appendChild(streamMsgDiv);

    appendStatusIndicator(statusId, streamMsgDiv);

    const contentContainer = document.createElement("div");
    contentContainer.className = "flex flex-col text-[15px] text-gemini-text dark:text-gemini-darkText leading-relaxed max-w-3xl w-full pr-2 sm:pr-0";
    const contentBox = document.createElement("div");
    contentBox.className = "content-box";
    contentContainer.appendChild(contentBox);
    streamMsgDiv.appendChild(contentContainer);
    scrollChatToBottom("auto", true);

    let backendMetaFinal = null;
    let lastRenderTime = 0;
    let renderTimeout = null;
    const streamStartTime = performance.now();
    let earlyRegeneratedMessage = null;

    if (activeStreamController) {
      activeStreamController.abort();
    }
    activeStreamController = new AbortController();

    await sendChatMessageStream({
      message: userMessage,
      history: messages.slice(0, userIndex),
      locale: resolveLocale(getAppSettings),
      mode,
      token,
      signal: activeStreamController.signal,
      profileContext: {
        ...(getCurrentCloudProfileContext() || {}),
        settingsMetadata: buildChatSettingsMetadata(),
      },
      onChunk: (chunkText) => {
        streamResponseStr += chunkText;

        // Finalize the "Thinking..." indicator when the response delimiter appears
        if (!firstChunkReceived) {
          const hasDelimiter = /\*{2}\s*(?:Response|Balanced\s*Reframe)\s*:?\s*\*{2}/i.test(streamResponseStr)
            || /(?:\n|^)\s*(?:Response|Balanced\s*Reframe)\s*:\s*/i.test(streamResponseStr);
          if (hasDelimiter) {
            firstChunkReceived = true;
            finalizeStatusIndicator(statusId, performance.now() - streamStartTime);
          }
        }

        const now = performance.now();
        if (now - lastRenderTime > 150) {
          lastRenderTime = now;
          if (renderTimeout) { cancelAnimationFrame(renderTimeout); renderTimeout = null; }
          contentBox.innerHTML = processStructuredResponse(streamResponseStr).finalHtml;
          scrollChatToBottom("auto");
        } else if (!renderTimeout) {
          renderTimeout = requestAnimationFrame(() => {
            renderTimeout = null;
            lastRenderTime = performance.now();
            contentBox.innerHTML = processStructuredResponse(streamResponseStr).finalHtml;
            scrollChatToBottom("auto");
          });
        }
      },
      onStatus: (status) => {
        if (status === "text_finished") {
          if (renderTimeout) { cancelAnimationFrame(renderTimeout); renderTimeout = null; }
          const elapsedMs = performance.now() - streamStartTime;
          const finalParsed = processStructuredResponse(streamResponseStr, elapsedMs);
          contentBox.innerHTML = finalParsed.finalHtml;

          if (finalParsed.timelineHtml) {
            const timelineDiv = document.createElement("div");
            timelineDiv.innerHTML = finalParsed.timelineHtml;
            contentContainer.insertBefore(timelineDiv, contentBox);
            document.getElementById(statusId)?.remove();
          } else {
            if (!firstChunkReceived) {
              finalizeStatusIndicator(statusId, elapsedMs);
            }
          }

          scrollChatToBottom("auto");
          isGenerating = false;
          notifyResponseComplete();
          setInputState({ disabled: false, locked: isSessionLocked });
          document.getElementById("chat-input")?.focus();

          const replyText = streamResponseStr.trim();
          earlyRegeneratedMessage = addMessage("MindPal", replyText, {
            requestId: null, providerUsed: null, safety: null,
            ragUsed: [], memoryUpdated: false, regenerated: true, generationTimeMs: elapsedMs,
          });

          notifyFromSetting("responseComplete", "MindPal response ready", "MindPal finished the regenerated response.");

          if (!isCrisisReply(replyText, "")) {
            contentContainer.appendChild(buildMessageActions(replyText));
            refreshIcons();
          }
        }
      },
      onMetadata: (meta) => {
        backendMetaFinal = meta;
        if (meta.pro_usage) updateUsageFromMeta(meta.pro_usage);
        if (meta.usage) syncUsageFromBackend(meta.usage);
      },
    });

    const reply = truncateRepetition(streamResponseStr.trim()) || streamResponseStr.trim();
    if (!reply) throw new Error("Backend returned empty reply.");

    if (isSafetyLock(backendMetaFinal)) isSessionLocked = true;

    let regeneratedRecord = earlyRegeneratedMessage;
    if (regeneratedRecord) {
      regeneratedRecord.text = reply;
      regeneratedRecord.requestId = backendMetaFinal?.request_id || null;
      regeneratedRecord.providerUsed = backendMetaFinal?.provider_used || null;
      regeneratedRecord.safety = backendMetaFinal?.safety || null;
      regeneratedRecord.ragUsed = backendMetaFinal?.rag_used || [];
      regeneratedRecord.memoryUpdated = Boolean(backendMetaFinal?.memory_updated);
    } else {
      regeneratedRecord = addMessage("MindPal", reply, {
        requestId: backendMetaFinal?.request_id || null,
        providerUsed: backendMetaFinal?.provider_used || null,
        safety: backendMetaFinal?.safety || null,
        ragUsed: backendMetaFinal?.rag_used || [],
        memoryUpdated: Boolean(backendMetaFinal?.memory_updated),
        regenerated: true,
      });
    }

    scheduleCloudMessageSync(regeneratedRecord);
    handleBackendMemoryUpdates(backendMetaFinal);

    const safetyLevel = backendMetaFinal?.safety?.level || backendMetaFinal?.safety?.user_visible_category || "";
    if (isCrisisReply(reply, safetyLevel)) {
      contentContainer.className = "flex flex-col text-[15px] text-rose-700 dark:text-rose-400 font-medium leading-relaxed max-w-3xl w-full pr-2 sm:pr-0";
      contentContainer.querySelector(".action-buttons")?.remove();
    }

    if (window.MINDPAL_CONFIG?.SHOW_RESPONSE_DEBUG && backendMetaFinal) {
      const metaEl = buildBackendMeta(backendMetaFinal);
      if (metaEl) contentContainer.appendChild(metaEl);
    }

    bindAccordion(streamMsgDiv);
    refreshIcons();
  } catch (error) {
    if (error?.name === "AbortError") {
      if (streamMsgDiv) streamMsgDiv.remove();
      return;
    }
    console.error("regenerateLastUserMessage error:", error);
    if (!streamResponseStr.trim() && streamMsgDiv) streamMsgDiv.remove();
    if (!firstChunkReceived) removeStatusIndicator(statusId);

    const fallback = buildClientFallbackReply(error);
    const fallbackRecord = addMessage("MindPal", fallback, {
      providerUsed: "client_fallback",
      errorCode: error?.code || "frontend_regenerate_error",
      regenerated: true,
    });
    scheduleCloudMessageSync(fallbackRecord);

    try {
      await appendMessageToUI(fallback, "bot", { smoothScroll: true, typewriter: true });
    } catch (renderError) {
      console.error("Failed to render regenerate fallback:", renderError);
    }
    notifyFromSetting("responseComplete", "MindPal response ready", "MindPal finished the fallback response.");
  } finally {
    isGenerating = false;
    setInputState({ disabled: false, locked: isSessionLocked });
    if (!isSessionLocked) document.getElementById("chat-input")?.focus();
    updateProfileUI(getCurrentUser());
  }
}

// ═══════════════════════════════════════════════════════════════
// Debug metadata
// ═══════════════════════════════════════════════════════════════

function buildBackendMeta(meta) {
  const provider = meta.provider_used || meta.providerUsed;
  const requestId = meta.request_id || meta.requestId;
  const ragUsed = meta.rag_used || meta.ragUsed || [];

  if (!provider && !requestId && !ragUsed.length) return null;

  const wrapper = document.createElement("details");
  wrapper.className = "mt-3 text-[12px] text-gray-400 dark:text-gray-500";

  const ragText = Array.isArray(ragUsed) && ragUsed.length
    ? ragUsed.slice(0, 3).map((item) => escapeHtml(item.technique || item.grounding_id || "grounding")).join(", ")
    : "none";

  wrapper.innerHTML = `
    <summary class="cursor-pointer select-none hover:text-gray-600 dark:hover:text-gray-300">Response details</summary>
    <div class="mt-2 space-y-1">
      ${provider ? `<div>Provider: ${escapeHtml(provider)}</div>` : ""}
      ${requestId ? `<div>Request: ${escapeHtml(requestId)}</div>` : ""}
      <div>Grounding: ${ragText}</div>
    </div>
  `;

  return wrapper;
}

// ═══════════════════════════════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════════════════════════════

window.addEventListener("beforeunload", () => {
  cleanupAuth();
});
