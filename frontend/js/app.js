// frontend/js/app.js

import {
  buildClientFallbackReply,
  deleteMemory,
  deleteMemoryGraphItem,
  getCurrentUserProfile,
  loadUserProfile,
  loadMemory,
  loadMemoryGraph,
  mergeMemoryGraph,
  normalizeChatHistory,
  saveMemory,
  saveMemoryGraph,
  sendChatMessage,
  sendChatMessageStream,
  deleteCurrentCloudChat,
  loadCurrentCloudChat,
  replaceCurrentCloudChat,
  upsertCloudChatMessages,
  updateUserProfilePreferences,
} from "./api.js?v=20260615-streaming-v7";

import {
  authIsConfigured,
  getCurrentUser,
  getIdToken,
  initAuth,
  onAuthChange,
  signInWithGoogle,
  signOut,
} from "./auth.js?v=20260615-streaming-v7";

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
  toggleTheme,
  updateProfileUI,
} from "./ui_state.js?v=20260615-streaming-v7";

import { initVoice } from "./voice.js?v=20260615-streaming-v7";

import {
  formatMarkdown,
  stripMarkdown,
  appendSectionLine,
  sleep,
  typewriteHTML,
  bindAccordion
} from "./utils/dom.js";

import {
  processStructuredResponse
} from "./utils/chat_helpers.js";

import {
  applyVisualSettings,
  buildChatSettingsMetadata,
  buildProfilePreferencesPatch,
  getAppSettings,
  hydrateSettingsFromProfile,
  mergeAppSettings,
  requestBrowserNotificationsIfNeeded,
  setAppSetting,
} from "./settings_store.js?v=20260615-streaming-v7";

import {
  initSettingsUI,
  bindSettingsControls,
  bindSettingsChoiceEvents,
  bindKeyboardShortcuts,
  persistAppSettingsToCloud,
  renderSettingsControls,
  notifyFromSetting
} from "./components/settings_ui.js";

import {
  initMemoryUI,
  renderMemoryInspector
} from "./components/memory_inspector.js";

import {
  answerQuestionFromMemory,
  answerQuestionFromMemoryGraph,
  classifyAndStoreMemoryFromMessage,
  classifyAndStoreMemoryGraphFromMessage,
  createEmptyMemory,
  createEmptyMemoryGraph,
  getMemoryInspectorCards,
  getMemoryInspectorRows,
  loadMemoryGraphContext,
  loadMemoryContext,
  memoryGraphFromBackend,
  memoryGraphFromLegacyMemory,
  memoryGraphToBackend,
  memoryFromBackendSummary,
  memoryToBackendSummary,
  mergeMemoryGraphs,
  saveMemoryContext,
  saveMemoryGraphContext,
  mergeMemoryContexts,
} from "./memory_engine.js?v=20260615-streaming-v7";

let isGenerating = false;
let isSessionLocked = false;
let voiceController = null;
let authUnsubscribe = null;
let cloudConnectInProgress = false;
let memoryContext = loadMemoryContext();
let memoryGraphContext = loadMemoryGraphContext();
let currentCloudProfileContext = null;
let cloudChatHydrated = false;
let cloudChatSyncInFlight = false;
let cloudChatSyncTimer = null;

let globalLoaderRemoved = false;
export function removeGlobalLoader() {
  if (globalLoaderRemoved) return;
  globalLoaderRemoved = true;
  const loader = document.getElementById("global-loader");
  if (loader) {
    setTimeout(() => {
      loader.classList.add("opacity-0");
      setTimeout(() => loader.remove(), 700);
    }, 150);
  }
}
const pendingCloudChatMessages = [];

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

document.addEventListener("DOMContentLoaded", bootstrap);

async function bootstrap() {
  refreshIcons();
  initializeTheme();
  applyVisualSettings();
  loadState();

  await initFrontendAuth();

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
    get currentCloudProfileContext() { return currentCloudProfileContext; }
  });

  initMemoryUI({
    refreshIcons,
    deleteMemoryEntry,
    editMemoryEntry,
    toggleMemoryPin,
    clearMemoryCategory,
    persistMemoryContextSafe,
    getMemoryGraphContext: () => memoryGraphContext
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
  bindModeSelector();
  bindMoodButtons();
  bindConversationActions();

  voiceController = initVoice();

  renderPersistedChat();
  updateProfileUI(getCurrentUser());
  setGreeting();
  setInputState({ disabled: false, locked: false });

  refreshIcons();

  if (!authIsConfigured()) {
    removeGlobalLoader();
  }
}

async function initFrontendAuth() {
  if (!authIsConfigured()) {
    setCloudSyncEnabled(false);
    return;
  }

  try {
    await initAuth();

    authUnsubscribe = onAuthChange(async (user) => {
      if (!user) {
        if (!cloudConnectInProgress) {
          setCloudSyncEnabled(false);
          updateProfileUI(null);
        }
        removeGlobalLoader();
        return;
      }

      if (user.displayName) {
        setUserName(user.displayName);
      }

      if (cloudConnectInProgress) {
        updateProfileUI(user);
        return;
      }

      try {
        const token = await getIdToken();

        if (!token) {
          throw new Error("Firebase returned no ID token.");
        }

        const profile = await getCurrentUserProfile(token);
        const storedProfile = await loadUserProfile(token).catch(() => null);
        if (storedProfile) {
          hydrateSettingsFromProfile(storedProfile);
        }

        currentCloudProfileContext = {
          ...buildCloudProfileContext(user, profile),
          settingsMetadata: buildChatSettingsMetadata(),
        };
        await hydrateCloudMemory(token);
        await hydrateCloudChat(token);

        setCloudSyncEnabled(true);
        updateProfileUI(user);
      } catch (error) {
        console.warn("Silent cloud profile verification failed:", error);
        currentCloudProfileContext = null;
        memoryContext = loadMemoryContext();
        memoryGraphContext = loadMemoryGraphContext();
        setCloudSyncEnabled(false);
        updateProfileUI(null);
      } finally {
        removeGlobalLoader();
      }
    });
  } catch (error) {
    console.warn("Firebase frontend auth init failed:", error);
    setCloudSyncEnabled(false);
    removeGlobalLoader();
  }
}




async function hydrateCloudMemory(token) {
  if (!token) return;

  try {
    const localGraph = saveMemoryGraphContext(memoryGraphContext);
    const response = await loadMemoryGraph(token);
    if (response?.loaded && response.graph) {
      const cloudGraph = memoryGraphFromBackend(response.graph);
      const mergedGraph = mergeMemoryGraphs(cloudGraph, localGraph);
      memoryGraphContext = saveMemoryGraphContext(mergedGraph);
      if (mergedGraph.version !== cloudGraph.version || mergedGraph.atoms.length !== cloudGraph.atoms.length) {
        await mergeMemoryGraph(memoryGraphToBackend(localGraph), token);
      }
    } else {
      memoryGraphContext = saveMemoryGraphContext(localGraph);
      await saveMemoryGraph(memoryGraphToBackend(memoryGraphContext), token);
    }

    const legacyResponse = await loadMemory(token).catch(() => null);
    if (legacyResponse?.loaded && legacyResponse.summary) {
      memoryContext = saveMemoryContext(mergeMemoryContexts(memoryContext, memoryFromBackendSummary(legacyResponse.summary)));
    } else {
      memoryContext = saveMemoryContext(memoryContext);
      await saveMemory(memoryToBackendSummary(memoryContext), token);
    }
    renderMemoryInspector();
  } catch (error) {
    console.warn("Cloud memory load failed; using local memory.", error);
    memoryContext = loadMemoryContext();
    memoryGraphContext = loadMemoryGraphContext();
    renderMemoryInspector();
  }
}


async function hydrateCloudChat(token) {
  if (!token || cloudChatHydrated) {
    cloudChatHydrated = true;
    return;
  }

  try {
    const response = await loadCurrentCloudChat(token);
    const cloudMessages = normalizeCloudMessages(response?.chat?.messages || []);
    const localMessages = normalizeLocalMessages(getState().chatMemory || []);
    const merged = mergeChatMessages(localMessages, cloudMessages);

    if (merged.length) {
      replaceChatMemory(merged);
      renderPersistedChat();
      setChatStarted(true);
    }

    cloudChatHydrated = true;

    if (merged.length && merged.length !== cloudMessages.length) {
      await replaceCurrentCloudChat(merged, token);
    }

    await flushPendingCloudChatMessages();
  } catch (error) {
    console.warn("Cloud chat hydration failed:", error);
  }
}

function scheduleCloudMessageSync(message) {
  if (!message || !getCurrentUser()) return;

  pendingCloudChatMessages.push(normalizeLocalMessage(message));

  if (cloudChatSyncTimer) {
    window.clearTimeout(cloudChatSyncTimer);
  }

  cloudChatSyncTimer = window.setTimeout(() => {
    flushPendingCloudChatMessages();
  }, 250);
}

async function flushPendingCloudChatMessages() {
  if (cloudChatSyncInFlight || pendingCloudChatMessages.length === 0) return;

  const token = await getIdToken();
  if (!token) return;

  cloudChatSyncInFlight = true;

  try {
    const batch = pendingCloudChatMessages.splice(0, pendingCloudChatMessages.length);
    const response = await upsertCloudChatMessages(batch, token);

    if (response?.chat?.messages) {
      const merged = mergeChatMessages(
        normalizeLocalMessages(getState().chatMemory || []),
        normalizeCloudMessages(response.chat.messages),
      );

      replaceChatMemory(merged);
    }
  } catch (error) {
    console.warn("Cloud chat sync failed; will retry later:", error);
  } finally {
    cloudChatSyncInFlight = false;
  }
}

async function replaceCloudChatSnapshotSafe(messages = null) {
  const token = await getIdToken();
  if (!token) return;

  try {
    await replaceCurrentCloudChat(normalizeLocalMessages(messages || getState().chatMemory || []), token);
  } catch (error) {
    console.warn("Cloud chat snapshot replace failed:", error);
  }
}

async function persistMemoryContextSafe() {
  try {
    const token = await getIdToken();
    memoryGraphContext = saveMemoryGraphContext(memoryGraphContext);

    if (!token) {
      saveMemoryContext(memoryContext);
      return;
    }

    await mergeMemoryGraph(memoryGraphToBackend(memoryGraphContext), token);
    await saveMemory(memoryToBackendSummary(memoryContext), token);
  } catch (error) {
    console.warn("Memory sync failed; local memory retained:", error);
    saveMemoryGraphContext(memoryGraphContext);
    saveMemoryContext(memoryContext);
  }
}

function normalizeCloudMessages(messages) {
  if (!Array.isArray(messages)) return [];

  return messages
    .map((message) => ({
      role: message.role === "User" || message.role === "user" ? "User" : "MindPal",
      text: String(message.text || message.content || "").trim(),
      messageId: message.message_id || message.messageId || stableMessageId(message),
      createdAt: message.created_at || message.createdAt || new Date().toISOString(),
      providerUsed: message.provider_used || message.providerUsed || "",
      requestId: message.request_id || message.requestId || "",
      safety: message.metadata?.safety || message.safety || null,
      ragUsed: message.metadata?.rag_used || message.metadata?.ragUsed || message.rag_used || message.ragUsed || [],
      memoryUpdated: Boolean(message.metadata?.memory_updated || message.metadata?.memoryUpdated || message.memory_updated || message.memoryUpdated),
      regenerated: Boolean(message.metadata?.regenerated || message.regenerated),
      syncStatus: "cloud",
    }))
    .filter((message) => message.text);
}

function normalizeLocalMessages(messages) {
  if (!Array.isArray(messages)) return [];

  return messages
    .map(normalizeLocalMessage)
    .filter((message) => message.text);
}

function normalizeLocalMessage(message) {
  return {
    ...message,
    role: message?.role === "User" || message?.role === "user" ? "User" : "MindPal",
    text: String(message?.text || message?.content || "").trim(),
    messageId: message?.messageId || message?.message_id || stableMessageId(message),
    createdAt: message?.createdAt || message?.created_at || new Date().toISOString(),
  };
}

function mergeChatMessages(localMessages, cloudMessages) {
  const byId = new Map();

  for (const message of [...localMessages, ...cloudMessages]) {
    const clean = normalizeLocalMessage(message);
    if (!clean.text) continue;

    byId.set(clean.messageId || stableMessageId(clean), clean);
  }

  return Array.from(byId.values()).sort((a, b) => {
    const dateA = String(a.createdAt || "");
    const dateB = String(b.createdAt || "");

    if (dateA !== dateB) {
      return dateA.localeCompare(dateB);
    }

    return String(a.messageId || "").localeCompare(String(b.messageId || ""));
  });
}

function stableMessageId(message) {
  const seed = `${message?.role || ""}|${message?.createdAt || message?.created_at || ""}|${message?.text || message?.content || ""}`;
  let hash = 0;

  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(index);
    hash |= 0;
  }

  return `msg_${Math.abs(hash).toString(36)}`;
}


function buildCloudProfileContext(user, profile = null) {
  if (!user && !profile) return null;

  const displayName =
    profile?.display_name ||
    profile?.displayName ||
    profile?.name ||
    user?.displayName ||
    "";

  const email =
    profile?.email ||
    user?.email ||
    "";

  const uid =
    profile?.uid ||
    profile?.firebase_uid ||
    profile?.user_id ||
    user?.uid ||
    "";

  if (!displayName && !email && !uid) return null;

  return {
    authenticated: true,
    displayName,
    email,
    uid,
  };
}

function formatCloudConnectErrorSafe(error) {
  console.error("MindPal cloud profile error:", error);

  const code = String(error?.code || "");
  const status = Number(error?.status || 0);
  const requestId = String(error?.requestId || "");
  const message = String(error?.message || "");

  if (code.includes("unauthorized-domain")) {
    return "Firebase rejected this domain. Add mindpal-demo.vercel.app to Firebase Auth authorized domains.";
  }

  if (code.includes("popup-closed-by-user")) {
    return "Sign-in popup was closed.";
  }

  if (code.includes("popup-blocked")) {
    return "Browser blocked the sign-in popup.";
  }

  if (code.includes("cancelled-popup-request")) {
    return "Another sign-in popup was already open.";
  }

  if (status === 401) {
    return `Backend rejected the Firebase token: ${code || "401"}${requestId ? ` (${requestId})` : ""}.`;
  }

  if (status === 403) {
    return `Backend blocked this profile request: ${code || "403"}${requestId ? ` (${requestId})` : ""}.`;
  }

  if (status === 404) {
    return "Backend /api/user/me route was not found.";
  }

  if (status >= 500) {
    return `Backend /api/user/me failed with ${status}${requestId ? ` (${requestId})` : ""}. Check Vercel logs.`;
  }

  if (code === "network_error" || message.toLowerCase().includes("failed to fetch")) {
    return "Browser could not reach /api/user/me. Check API_BASE_URL and deployment routes.";
  }

  return `Cloud profile failed${code ? `: ${code}` : ""}${message ? ` — ${message}` : ""}.`;
}

function bindTheme() {
  document.getElementById("theme-toggle-btn")?.addEventListener("click", () => {
    const isDark = document.documentElement.classList.contains("dark");
    setAppSetting("appearance", isDark ? "light" : "dark");
    renderSettingsControls(document.getElementById("profile-content") || document);
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
    if (document.querySelector('[data-settings-panel="memory"]')?.classList.contains("active")) {
      renderMemoryInspector();
    }
    openModal("profile-modal", "profile-content");
  });

  closeProfileBtn?.addEventListener("click", () => {
    closeModal("profile-modal", "profile-content");
  });

  closeProfileMobileBtn?.addEventListener("click", () => {
    closeModal("profile-modal", "profile-content");
  });

  profileModal?.addEventListener("click", (event) => {
    if (event.target === profileModal) {
      closeProfileBtn?.click();
    }
  });

  connectBtn?.addEventListener("click", async () => {
    if (!authIsConfigured()) {
      showToast("Firebase web config is missing.");
      return;
    }

    setButtonBusy(connectBtn, true, "Connecting...");
    cloudConnectInProgress = true;

    try {
      const user = await signInWithGoogle();

      if (!user) {
        throw new Error("Firebase sign-in returned no user.");
      }

      if (user.displayName) {
        setUserName(user.displayName);
      }

      const token = await getIdToken({ forceRefresh: true });

      if (!token) {
        throw new Error("Firebase returned no ID token.");
      }

      console.info("MindPal auth debug:", {
        uid: user.uid,
        email: user.email,
        providerId: user.providerId,
        tokenPrefix: token.slice(0, 16),
      });

      const profile = await getCurrentUserProfile(token);
      const storedProfile = await loadUserProfile(token).catch(() => null);
      if (storedProfile) {
        hydrateSettingsFromProfile(storedProfile);
      }

      console.info("MindPal backend profile:", profile);

      currentCloudProfileContext = {
        ...buildCloudProfileContext(user, profile),
        settingsMetadata: buildChatSettingsMetadata(),
      };
      await persistAppSettingsToCloud();
      await hydrateCloudMemory(token);
      await hydrateCloudChat(token);

      setCloudSyncEnabled(true);
      updateProfileUI(user);

      showToast("Cloud profile connected.");
    } catch (error) {
      setCloudSyncEnabled(false);
      updateProfileUI(null);
      showToast(formatCloudConnectErrorSafe(error));
    } finally {
      cloudConnectInProgress = false;
      setButtonBusy(connectBtn, false);
    }
  });

  disconnectBtn?.addEventListener("click", async () => {
    try {
      await signOut();
    } catch {
      // Continue local disconnect even if Firebase signout fails.
    }

    currentCloudProfileContext = null;
    memoryContext = loadMemoryContext();
    memoryGraphContext = loadMemoryGraphContext();
    cloudChatHydrated = false;
    pendingCloudChatMessages.length = 0;
    setCloudSyncEnabled(false);
    updateProfileUI(null);
    showToast("Signed out. Local mode enabled.");
  });

  userNameInput?.addEventListener("change", (event) => {
    const nextName = setUserName(event.target.value);
    memoryContext.preferredName = nextName === "Friend" ? "" : nextName;
    memoryContext.user.preferredName = memoryContext.preferredName;
    if (memoryContext.preferredName) {
      memoryGraphContext = mergeMemoryGraphs(memoryGraphContext, memoryGraphFromLegacyMemory(memoryContext));
    }
    saveMemoryGraphContext(memoryGraphContext);
    saveMemoryContext(memoryContext);
    void persistMemoryContextSafe();
    renderMemoryInspector();
    updateProfileUI(getCurrentUser());
    showToast(nextName === "Friend" ? "Profile name cleared." : "Profile updated.");
  });

  document.getElementById("delete-account-btn")?.addEventListener("click", async () => {
    const user = getCurrentUser();
    if (!user) {
      showToast("No cloud account is connected.");
      return;
    }

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

    currentCloudProfileContext = null;
    clearChatMemory();
    memoryContext = saveMemoryContext(createEmptyMemory());
    memoryGraphContext = saveMemoryGraphContext(createEmptyMemoryGraph());
    renderMemoryInspector();
    document.getElementById("chat-history")?.replaceChildren();
    setChatStarted(false);
    cloudChatHydrated = false;
    pendingCloudChatMessages.length = 0;
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

  closeStreakBtn?.addEventListener("click", () => {
    closeModal("streak-modal", "streak-content");
  });

  streakModal?.addEventListener("click", (event) => {
    if (event.target === streakModal) {
      closeStreakBtn?.click();
    }
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
      await hydrateCloudMemory(token);
      showToast("Memory refreshed.");
      return;
    }

    memoryContext = loadMemoryContext();
    memoryGraphContext = loadMemoryGraphContext();
    renderMemoryInspector();
    showToast("Local memory refreshed.");
  });
}

// renderMemoryInspector moved to components/memory_inspector.js

function bindSettingsTabs() {
  const buttons = Array.from(document.querySelectorAll("[data-settings-tab]"));
  const panels = Array.from(document.querySelectorAll("[data-settings-panel]"));
  const mobileSelect = document.getElementById("settings-mobile-tabs");

  const activate = (tab) => {
    const nextTab = tab || "general";

    buttons.forEach((button) => {
      button.classList.toggle("active", button.getAttribute("data-settings-tab") === nextTab);
    });

    panels.forEach((panel) => {
      const isActive = panel.getAttribute("data-settings-panel") === nextTab;
      panel.classList.toggle("active", isActive);
      panel.hidden = !isActive;
    });

    if (mobileSelect && mobileSelect.value !== nextTab) {
      mobileSelect.value = nextTab;
    }

    if (nextTab === "memory") {
      renderMemoryInspector();
    }
  };

  buttons.forEach((button) => {
    button.addEventListener("click", () => activate(button.getAttribute("data-settings-tab") || "general"));
  });

  mobileSelect?.addEventListener("change", (event) => {
    activate(event.target.value);
  });

  activate("general");
}

// Settings UI functions moved to components/settings_ui.js

function startNewLocalChat() {
  if (isGenerating) {
    showToast("Wait for the current response before starting a new chat.");
    return;
  }

  clearChatMemory();
  document.getElementById("chat-history")?.replaceChildren();
  clearInput();
  setChatStarted(false);
  updateProfileUI(getCurrentUser());
  showToast("New local chat started.");
}



async function deleteMemoryEntry(atomId) {
  const cleanId = String(atomId || "");
  const now = new Date().toISOString();
  memoryGraphContext.atoms = memoryGraphContext.atoms.map((atom) => (
    atom.id === cleanId
      ? { ...atom, status: "deleted", pinned: false, updated_at: now, metadata: { ...(atom.metadata || {}), deleted_by_user: true } }
      : atom
  ));

  memoryGraphContext = saveMemoryGraphContext(memoryGraphContext);
  const token = await getIdToken();
  if (token) {
    await deleteMemoryGraphItem(cleanId, token).catch((error) => console.warn("Cloud memory delete failed:", error));
  }
  showToast("Memory deleted.");
}

function showCustomDialog({ title = "Confirm", message = "", input = false, defaultValue = "", confirmText = "Confirm", danger = false } = {}) {
  return new Promise((resolve) => {
    const dialog = document.getElementById("custom-dialog");
    const content = document.getElementById("custom-dialog-content");
    const titleEl = document.getElementById("custom-dialog-title");
    const messageEl = document.getElementById("custom-dialog-message");
    const inputWrap = document.getElementById("custom-dialog-input-wrap");
    const inputEl = document.getElementById("custom-dialog-input");
    const confirmBtn = document.getElementById("custom-dialog-confirm");
    const cancelBtn = document.getElementById("custom-dialog-cancel");

    if (!dialog || !content) { resolve(input ? null : false); return; }

    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;
    if (confirmBtn) {
      confirmBtn.textContent = confirmText;
      confirmBtn.classList.toggle("dialog-danger", Boolean(danger));
    }

    if (input && inputWrap && inputEl) {
      inputWrap.classList.remove("hidden");
      inputEl.value = defaultValue;
    } else if (inputWrap) {
      inputWrap.classList.add("hidden");
    }

    dialog.classList.remove("opacity-0", "pointer-events-none");
    content.classList.remove("scale-95");
    document.body.classList.add("overflow-hidden");

    if (input && inputEl) {
      window.setTimeout(() => inputEl.focus(), 100);
    }

    const onConfirm = () => { cleanup(); resolve(input ? (inputEl?.value ?? "") : true); };
    const onCancel = () => { cleanup(); resolve(input ? null : false); };
    const onBackdrop = (e) => { if (e.target === dialog) onCancel(); };
    const onInputKeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); onConfirm(); } };

    if (input && inputEl) {
      inputEl.addEventListener("keydown", onInputKeydown);
    }

    const cleanup = () => {
      dialog.classList.add("opacity-0", "pointer-events-none");
      content.classList.add("scale-95");
      confirmBtn?.removeEventListener("click", onConfirm);
      cancelBtn?.removeEventListener("click", onCancel);
      dialog.removeEventListener("click", onBackdrop);
      if (input && inputEl) {
        inputEl.removeEventListener("keydown", onInputKeydown);
      }
      
      const anyModalOpen = document.querySelectorAll('.fixed.inset-0:not(.opacity-0)').length > 0;
      if (!anyModalOpen) {
        document.body.classList.remove("overflow-hidden");
      }
    };

    confirmBtn?.addEventListener("click", onConfirm);
    cancelBtn?.addEventListener("click", onCancel);
    dialog.addEventListener("click", onBackdrop);
  });
}

async function editMemoryEntry(atomId) {
  const atom = memoryGraphContext.atoms.find((item) => item.id === atomId);
  if (!atom) return;

  const next = await showCustomDialog({
    title: "Edit memory",
    message: "Update or clear this memory entry.",
    input: true,
    defaultValue: atom.value,
    confirmText: "Save",
  });
  if (next === null) return;

  const value = next.trim();
  if (!value) {
    void deleteMemoryEntry(atomId);
    return;
  }

  memoryGraphContext.atoms = memoryGraphContext.atoms.map((item) => (
    item.id === atomId
      ? { ...item, value, display_value: value, source: "manual", confidence: Math.max(item.confidence || 0, 0.95), updated_at: new Date().toISOString() }
      : item
  ));

  memoryGraphContext = saveMemoryGraphContext(memoryGraphContext);
  showToast("Memory updated.");
}

function toggleMemoryPin(atomId) {
  memoryGraphContext.atoms = memoryGraphContext.atoms.map((atom) => (
    atom.id === atomId ? { ...atom, pinned: !atom.pinned, updated_at: new Date().toISOString() } : atom
  ));
  memoryGraphContext = saveMemoryGraphContext(memoryGraphContext);
}

function clearMemoryCategory(category) {
  const now = new Date().toISOString();
  memoryGraphContext.atoms = memoryGraphContext.atoms.map((atom) => (
    atom.category === category
      ? { ...atom, status: "deleted", pinned: false, updated_at: now, metadata: { ...(atom.metadata || {}), deleted_by_user: true } }
      : atom
  ));
  memoryGraphContext = saveMemoryGraphContext(memoryGraphContext);
  showToast("Memory category cleared.");
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

      if (!isGenerating && !isSessionLocked) {
        handleSend();
      }
    }
  });

  sendBtn?.addEventListener("click", () => {
    if (!isGenerating && !isSessionLocked) {
      handleSend();
    }
  });
}

function bindModeSelector() {
  const modeBtn = document.getElementById("mode-selector-btn");
  const dropdown = document.getElementById("mode-dropdown");

  modeBtn?.addEventListener("click", (event) => {
    if (isSessionLocked) return;

    event.stopPropagation();
    dropdown?.classList.toggle("hidden");
  });

  document.addEventListener("click", (event) => {
    if (!dropdown || !modeBtn) return;

    if (!dropdown.contains(event.target) && !modeBtn.contains(event.target)) {
      dropdown.classList.add("hidden");
    }
  });

  document.querySelectorAll(".mode-option").forEach((option) => {
    option.addEventListener("click", () => {
      const modeText = document.getElementById("current-mode-text");
      const mode = option.getAttribute("data-mode") || "Active Listen";

      if (modeText) {
        modeText.textContent = mode;
      }

      dropdown?.classList.add("hidden");

      if (!isSessionLocked) {
        document.getElementById("chat-input")?.focus();
      }
    });
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

      handleSend();
    });
  });
}

function bindConversationActions() {
  document.getElementById("export-chat-btn")?.addEventListener("click", () => {
    exportConversationLog();
  });

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
    } catch {
      // Local clear should still happen.
    }

    clearChatMemory();
    memoryContext = saveMemoryContext(createEmptyMemory());
    memoryGraphContext = saveMemoryGraphContext(createEmptyMemoryGraph());
    renderMemoryInspector();

    const chatHistory = document.getElementById("chat-history");
    if (chatHistory) {
      chatHistory.innerHTML = "";
    }

    setChatStarted(false);
    showToast("Memory cleared.");
  });
}

async function handleSend() {
  const inputEl = document.getElementById("chat-input");
  const text = inputEl?.value?.trim() || "";

  if (!text || isGenerating || isSessionLocked) return;

  isGenerating = true;
  voiceController?.setGenerating(true);
  setInputState({ disabled: true, locked: false });
  setChatStarted(true);

  await appendMessageToUI(text, "user", { smoothScroll: true });

  const userMessageRecord = addMessage("User", text);
  scheduleCloudMessageSync(userMessageRecord);
  clearInput();

  const recentMessages = getState().chatMemory.slice(-8);
  const memoryResult = classifyAndStoreMemoryFromMessage(text, {
    memoryContext,
    recentMessages,
  });
  const graphResult = classifyAndStoreMemoryGraphFromMessage(text, {
    graphContext: memoryGraphContext,
  });

  memoryContext = memoryResult.memory;
  memoryGraphContext = graphResult.graph;
  if (memoryResult.saved.length || graphResult.saved.length) {
    renderMemoryInspector();
    void persistMemoryContextSafe();
  }

  const localMemoryReply = graphResult.localReply || memoryResult.localReply;
  if ((graphResult.shouldIntercept || memoryResult.shouldIntercept) && localMemoryReply) {
    const memoryReplyRecord = addMessage("MindPal", localMemoryReply, {
      providerUsed: "local_memory",
      memoryUpdated: true,
    });

    scheduleCloudMessageSync(memoryReplyRecord);

    await appendMessageToUI(localMemoryReply, "bot", {
      smoothScroll: true,
      typewriter: true,
    });

    isGenerating = false;
    voiceController?.setGenerating(false);
    setInputState({ disabled: false, locked: isSessionLocked });
    updateProfileUI(getCurrentUser());
    document.getElementById("chat-input")?.focus();
    return;
  }

  const memoryDirectAnswer = answerQuestionFromMemoryGraph(text, memoryGraphContext) || answerQuestionFromMemory(text, memoryContext);

  if (memoryDirectAnswer) {
    const memoryAnswerRecord = addMessage("MindPal", memoryDirectAnswer, {
      providerUsed: "local_memory",
      memoryUsed: true,
    });

    scheduleCloudMessageSync(memoryAnswerRecord);

    await appendMessageToUI(memoryDirectAnswer, "bot", {
      smoothScroll: true,
      typewriter: true,
    });

    isGenerating = false;
    voiceController?.setGenerating(false);
    setInputState({ disabled: false, locked: isSessionLocked });
    updateProfileUI(getCurrentUser());
    document.getElementById("chat-input")?.focus();
    return;
  }

  // Send clean user message only. Memory/context goes in system prompt via backend.
  const outboundMessage = text;

  const statusId = `status-${Date.now()}`;

  // Create streaming container before try so catch can clean it up on failure
  const chatHistory = document.getElementById("chat-history");
  let streamMsgDiv = document.createElement("div");
  streamMsgDiv.className = "flex flex-col gap-1 w-full self-start animate-fade-in pl-4 sm:pl-10 pr-2 sm:pr-4";
  if (chatHistory) chatHistory.appendChild(streamMsgDiv);

  appendStatusIndicator(statusId, streamMsgDiv);

  let contentBox = null;
  let streamResponseStr = "";

  let firstChunkReceived = false;

  try {
    const state = getState();
    const token = await getIdToken();
    const mode = document.getElementById("current-mode-text")?.textContent || "Active Listen";
    const contentContainer = document.createElement("div");
    contentContainer.className = "flex flex-col text-[15px] text-gemini-text dark:text-gemini-darkText leading-relaxed max-w-3xl w-full pr-2 sm:pr-0";
    contentBox = document.createElement("div");
    contentBox.className = "content-box";
    contentContainer.appendChild(contentBox);
    streamMsgDiv.appendChild(contentContainer);
    scrollChatToBottom("auto", true);
    let backendMetaFinal = null;

    let lastRenderTime = 0;
    let renderTimeout = null;
    const streamStartTime = performance.now();
    let earlyAssistantMessage = null;

    // Send clean message only. Memory/context managed by backend via system prompt.
    await sendChatMessageStream({
      message: outboundMessage,
      history: state.chatMemory,
      locale: resolveLocale(),
      mode,
      token,
      profileContext: {
        ...(currentCloudProfileContext || {}),
        settingsMetadata: buildChatSettingsMetadata(),
      },
      onChunk: (text) => {
        // Finalize the thinking indicator on the very first chunk (show elapsed time)
        if (!firstChunkReceived) {
          firstChunkReceived = true;
          finalizeStatusIndicator(statusId, performance.now() - streamStartTime);
        }
        streamResponseStr += text;

        const now = performance.now();
        if (now - lastRenderTime > 150) {
          lastRenderTime = now;
          if (renderTimeout) {
            cancelAnimationFrame(renderTimeout);
            renderTimeout = null;
          }
          // Render live markdown and strip any cognitive thought blocks until finished
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
        if (status === 'text_finished') {
          if (renderTimeout) {
            cancelAnimationFrame(renderTimeout);
            renderTimeout = null;
          }
          const elapsedMs = performance.now() - streamStartTime;
          const finalParsed = processStructuredResponse(streamResponseStr, elapsedMs);
          contentBox.innerHTML = finalParsed.finalHtml;
          
          if (finalParsed.timelineHtml) {
            const timelineDiv = document.createElement("div");
            timelineDiv.innerHTML = finalParsed.timelineHtml;
            contentContainer.insertBefore(timelineDiv, contentBox);
            
            // Remove the static status indicator since we have a rich timeline dropdown
            const statusEl = document.getElementById(statusId);
            if (statusEl) statusEl.remove();
          }
          
          scrollChatToBottom("auto");

          isGenerating = false;
          setInputState({ disabled: false, locked: isSessionLocked });
          document.getElementById("chat-input")?.focus();
          const replyText = streamResponseStr.trim();
          earlyAssistantMessage = addMessage("MindPal", replyText, {
            requestId: null,
            providerUsed: null,
            safety: null,
            ragUsed: [],
            memoryUpdated: false,
            generationTimeMs: elapsedMs,
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
      }
    });

    const reply = streamResponseStr.trim();
    if (!reply) {
      throw new Error("Backend returned empty reply.");
    }

    if (isSafetyLock(backendMetaFinal)) {
      isSessionLocked = true;
      voiceController?.setLocked(true);
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

    if (backendMetaFinal?.memory_summary) {
      memoryContext = saveMemoryContext(
        mergeMemoryContexts(memoryContext, memoryFromBackendSummary(backendMetaFinal.memory_summary)),
      );
    }

    if (backendMetaFinal?.memory_graph_snapshot && backendMetaFinal?.memory_graph_full_snapshot) {
      memoryGraphContext = saveMemoryGraphContext(memoryGraphFromBackend(backendMetaFinal.memory_graph_snapshot));
    } else if (backendMetaFinal?.memory_graph_delta) {
      memoryGraphContext = saveMemoryGraphContext(
        mergeMemoryGraphs(memoryGraphContext, memoryGraphFromBackend(backendMetaFinal.memory_graph_delta)),
      );
    }

    if (backendMetaFinal?.memory_summary || backendMetaFinal?.memory_graph_snapshot || backendMetaFinal?.memory_graph_delta) {
      renderMemoryInspector();
    }

    const safetyLevel = backendMetaFinal?.safety?.level || backendMetaFinal?.safety?.user_visible_category || "";
    const isCrisis = isCrisisReply(reply, safetyLevel);
    if (isCrisis) {
      contentContainer.className = "flex flex-col text-[15px] text-rose-700 dark:text-rose-400 font-medium leading-relaxed max-w-3xl w-full pr-2 sm:pr-0";
      const actionsEl = contentContainer.querySelector('.action-buttons');
      if (actionsEl) actionsEl.remove();
    }

    if (window.MINDPAL_CONFIG?.SHOW_RESPONSE_DEBUG && backendMetaFinal) {
      const metaEl = buildBackendMeta(backendMetaFinal);
      if (metaEl) contentContainer.appendChild(metaEl);
    }

    bindAccordion(streamMsgDiv);
    refreshIcons();
  } catch (error) {
    console.error("handleSend error:", error);
    // Remove the orphan streaming div only if no content was received
    if (!streamResponseStr.trim() && streamMsgDiv) {
      streamMsgDiv.remove();
    }
    
    // Check if the thought indicator is still waving, if so remove it since it failed
    if (!firstChunkReceived) {
      removeStatusIndicator(statusId);
    }

    const fallback = buildClientFallbackReply(error);

    const fallbackMessageRecord = addMessage("MindPal", fallback, {
      providerUsed: "client_fallback",
      errorCode: error?.code || "frontend_error",
    });

    scheduleCloudMessageSync(fallbackMessageRecord);

    try {
      await appendMessageToUI(fallback, "bot", {
        smoothScroll: true,
        typewriter: true,
      });
    } catch (renderError) {
      console.error("Failed to render fallback message:", renderError);
    }
    notifyFromSetting("responseComplete", "MindPal response ready", "MindPal finished the fallback response.");
  } finally {
    isGenerating = false;
    voiceController?.setGenerating(false);

    setInputState({ disabled: false, locked: isSessionLocked });

    if (!isSessionLocked) {
      document.getElementById("chat-input")?.focus();
    }

    updateProfileUI(getCurrentUser());
  }
}

function renderPersistedChat() {
  const state = getState();

  if (!state.chatMemory.length) {
    setChatStarted(false);
    return;
  }

  setChatStarted(true);

  const chatHistory = document.getElementById("chat-history");
  if (!chatHistory) return;

  chatHistory.innerHTML = "";

  for (const message of state.chatMemory) {
    appendMessageToUI(message.text, message.role === "User" ? "user" : "bot", {
      smoothScroll: false,
      typewriter: false,
      persist: false,
      backendMeta: message,
    });
  }

  scrollChatToBottom("auto", true);
}

async function appendMessageToUI(text, sender, {
  smoothScroll = true,
  typewriter = false,
  backendMeta = null,
} = {}) {
  const chatHistory = document.getElementById("chat-history");
  if (!chatHistory) return;

  const msgDiv = document.createElement("div");

  if (sender === "user") {
    msgDiv.className = "flex justify-end w-full animate-fade-in pl-4 sm:pl-10 pr-2 sm:pr-4";
    msgDiv.innerHTML = `
      <div class="bg-gemini-surface dark:bg-gemini-darkSurface text-gemini-text dark:text-gemini-darkText px-5 py-3 rounded-[24px] max-w-[80%] text-[15px] leading-relaxed">
        ${escapeHtml(text)}
      </div>
    `;

    chatHistory.appendChild(msgDiv);

    if (smoothScroll) scrollChatToBottom("auto", true);
    return;
  }

  const safetyLevel = backendMeta?.safety?.level || backendMeta?.safety?.user_visible_category || "";
  const isCrisis = isCrisisReply(text, safetyLevel);
  const parsed = processStructuredResponse(text);

  msgDiv.className = "flex flex-col gap-1 w-full self-start animate-fade-in pl-4 sm:pl-10 pr-2 sm:pr-4";

  const contentContainer = document.createElement("div");
  contentContainer.className = `flex flex-col text-[15px] ${
    isCrisis
      ? "text-rose-700 dark:text-rose-400 font-medium"
      : "text-gemini-text dark:text-gemini-darkText"
  } leading-relaxed max-w-3xl w-full pr-2 sm:pr-0`;

  if (parsed.timelineHtml) {
    const timelineDiv = document.createElement("div");
    timelineDiv.innerHTML = parsed.timelineHtml;
    contentContainer.appendChild(timelineDiv);
  }

  const contentBox = document.createElement("div");
  contentBox.className = "content-box";

  if (!parsed.timelineHtml && backendMeta?.generationTimeMs) {
    const timeSec = (backendMeta.generationTimeMs / 1000).toFixed(1);
    const staticThoughtHtml = `
      <div class="flex items-center gap-1 mb-2">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
          class="text-[#4285f4] dark:text-[#7baaf7] flex-shrink-0 opacity-80">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        <span class="text-[13px] text-[#5f6368] dark:text-[#9aa0a6] italic">
          Thought for ${timeSec}s
        </span>
      </div>
    `;
    const staticDiv = document.createElement("div");
    staticDiv.innerHTML = staticThoughtHtml;
    contentContainer.appendChild(staticDiv);
  }

  if (!typewriter) {
    contentBox.innerHTML = parsed.finalHtml;
  }

  contentContainer.appendChild(contentBox);

  if (!isCrisis) {
    contentContainer.appendChild(buildMessageActions(text));
  }

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

    const actions = contentContainer.querySelector(".action-buttons");
    actions?.classList.remove("opacity-0");
  }

  if (smoothScroll) {
    scrollChatToBottom("auto");
  }
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
  playBtn?.addEventListener("click", () => {
    speakText(stripMarkdown(text), playBtn);
  });

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

  actionDiv.querySelector(".action-retry")?.addEventListener("click", () => {
    regenerateLastUserMessage(text);
  });

  return actionDiv;
}

async function regenerateLastUserMessage(targetAssistantText = "") {
  if (isGenerating || isSessionLocked) return;

  const state = getState();
  const messages = Array.isArray(state.chatMemory) ? state.chatMemory : [];

  if (messages.length < 2) {
    showToast("Nothing to regenerate.");
    return;
  }

  const cleanTarget = String(targetAssistantText || "").trim();

  let assistantIndex = -1;

  if (cleanTarget) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];

      if (
        message?.role === "MindPal" &&
        String(message?.text || "").trim() === cleanTarget
      ) {
        assistantIndex = index;
        break;
      }
    }
  }

  if (assistantIndex < 0) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "MindPal") {
        assistantIndex = index;
        break;
      }
    }
  }

  if (assistantIndex < 0) {
    showToast("No assistant response to regenerate.");
    return;
  }

  let userIndex = assistantIndex - 1;

  while (userIndex >= 0 && messages[userIndex]?.role !== "User") {
    userIndex -= 1;
  }

  if (userIndex < 0) {
    showToast("No matching user message found.");
    return;
  }

  const userMessage = String(messages[userIndex]?.text || "").trim();

  if (!userMessage) {
    showToast("No matching user message found.");
    return;
  }

  const preservedMessages = messages.slice(0, assistantIndex);

  replaceChatMemory(preservedMessages);
  renderPersistedChat();
  void replaceCloudChatSnapshotSafe(preservedMessages);

  isGenerating = true;
  voiceController?.setGenerating(true);
  setInputState({ disabled: true, locked: false });
  setChatStarted(true);

  const statusId = `status-regenerate-${Date.now()}`;
  let streamResponseStr = "";
  let streamMsgDiv = null;
  let firstChunkReceived = false;

  try {
    const token = await getIdToken();
    const mode = document.getElementById("current-mode-text")?.textContent || "Active Listen";

    // Create streaming container before try so catch can clean it up on failure
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

    await sendChatMessageStream({
      message: userMessage,
      history: messages.slice(0, userIndex),
      locale: resolveLocale(),
      mode,
      token,
      profileContext: {
        ...(currentCloudProfileContext || {}),
        settingsMetadata: buildChatSettingsMetadata(),
      },
      onChunk: (text) => {
        // Finalize the thinking indicator on the very first chunk (show elapsed time)
        if (!firstChunkReceived) {
          firstChunkReceived = true;
          finalizeStatusIndicator(statusId, performance.now() - streamStartTime);
        }
        streamResponseStr += text;
        
        const now = performance.now();
        if (now - lastRenderTime > 150) {
          lastRenderTime = now;
          if (renderTimeout) {
            cancelAnimationFrame(renderTimeout);
            renderTimeout = null;
          }
          // Render live markdown and strip any cognitive thought blocks until finished
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
        if (status === 'text_finished') {
          if (renderTimeout) {
            cancelAnimationFrame(renderTimeout);
            renderTimeout = null;
          }
          const elapsedMs = performance.now() - streamStartTime;
          const finalParsed = processStructuredResponse(streamResponseStr, elapsedMs);
          contentBox.innerHTML = finalParsed.finalHtml;
          
          if (finalParsed.timelineHtml) {
            const timelineDiv = document.createElement("div");
            timelineDiv.innerHTML = finalParsed.timelineHtml;
            contentContainer.insertBefore(timelineDiv, contentBox);
            
            // Remove the static status indicator since we have a rich timeline dropdown
            const statusEl = document.getElementById(statusId);
            if (statusEl) statusEl.remove();
          }
          
          scrollChatToBottom("auto");

          isGenerating = false;
          setInputState({ disabled: false, locked: isSessionLocked });
          document.getElementById("chat-input")?.focus();
          const replyText = streamResponseStr.trim();
          earlyRegeneratedMessage = addMessage("MindPal", replyText, {
            requestId: null,
            providerUsed: null,
            safety: null,
            ragUsed: [],
            memoryUpdated: false,
            regenerated: true,
            generationTimeMs: elapsedMs,
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
      }
    });

    const reply = streamResponseStr.trim();
    if (!reply) {
      throw new Error("Backend returned empty reply.");
    }

    if (isSafetyLock(backendMetaFinal)) {
      isSessionLocked = true;
      voiceController?.setLocked(true);
    }

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

    if (backendMetaFinal?.memory_summary) {
      memoryContext = saveMemoryContext(
        mergeMemoryContexts(memoryContext, memoryFromBackendSummary(backendMetaFinal.memory_summary)),
      );
    }

    if (backendMetaFinal?.memory_graph_snapshot && backendMetaFinal?.memory_graph_full_snapshot) {
      memoryGraphContext = saveMemoryGraphContext(memoryGraphFromBackend(backendMetaFinal.memory_graph_snapshot));
    } else if (backendMetaFinal?.memory_graph_delta) {
      memoryGraphContext = saveMemoryGraphContext(
        mergeMemoryGraphs(memoryGraphContext, memoryGraphFromBackend(backendMetaFinal.memory_graph_delta)),
      );
    }

    if (backendMetaFinal?.memory_summary || backendMetaFinal?.memory_graph_snapshot || backendMetaFinal?.memory_graph_delta) {
      renderMemoryInspector();
    }

    const safetyLevel = backendMetaFinal?.safety?.level || backendMetaFinal?.safety?.user_visible_category || "";
    const isCrisis = isCrisisReply(reply, safetyLevel);
    if (isCrisis) {
      contentContainer.className = "flex flex-col text-[15px] text-rose-700 dark:text-rose-400 font-medium leading-relaxed max-w-3xl w-full pr-2 sm:pr-0";
      const actionsEl = contentContainer.querySelector('.action-buttons');
      if (actionsEl) actionsEl.remove();
    }

    if (window.MINDPAL_CONFIG?.SHOW_RESPONSE_DEBUG && backendMetaFinal) {
      const metaEl = buildBackendMeta(backendMetaFinal);
      if (metaEl) contentContainer.appendChild(metaEl);
    }

    bindAccordion(streamMsgDiv);
    refreshIcons();
  } catch (error) {
    console.error("regenerateLastUserMessage error:", error);
    
    // Remove the orphan streaming div only if no content was received
    if (!streamResponseStr.trim() && streamMsgDiv) {
      streamMsgDiv.remove();
    }
    
    // Check if the thought indicator is still waving, if so remove it since it failed
    if (!firstChunkReceived) {
      removeStatusIndicator(statusId);
    }

    const fallback = buildClientFallbackReply(error);

    const regeneratedFallbackRecord = addMessage("MindPal", fallback, {
      providerUsed: "client_fallback",
      errorCode: error?.code || "frontend_regenerate_error",
      regenerated: true,
    });

    scheduleCloudMessageSync(regeneratedFallbackRecord);

    try {
      await appendMessageToUI(fallback, "bot", {
        smoothScroll: true,
        typewriter: true,
      });
    } catch (renderError) {
      console.error("Failed to render regenerate fallback:", renderError);
    }
    notifyFromSetting("responseComplete", "MindPal response ready", "MindPal finished the fallback response.");
  } finally {
    isGenerating = false;
    voiceController?.setGenerating(false);

    setInputState({ disabled: false, locked: isSessionLocked });

    if (!isSessionLocked) {
      document.getElementById("chat-input")?.focus();
    }

    updateProfileUI(getCurrentUser());
  }
}

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

// DOM helpers moved to utils/dom.js

let activeSpeechUtterance = null;
let activeSpeechButton = null;
const cancelledUtterances = new WeakSet();

function speakText(text, button = null) {
  if (!("speechSynthesis" in window)) {
    showToast("Text-to-speech is not supported in this browser.");
    return;
  }

  const clean = String(text || "").trim();
  if (!clean) return;

  const sameButton = activeSpeechButton === button;

  if (window.speechSynthesis.speaking || activeSpeechUtterance) {
    if (activeSpeechUtterance) {
      cancelledUtterances.add(activeSpeechUtterance);
    }

    window.speechSynthesis.cancel();
    resetPlayButton(activeSpeechButton);

    activeSpeechUtterance = null;
    activeSpeechButton = null;

    if (sameButton) {
      return;
    }
  }

  const utterance = new SpeechSynthesisUtterance(clean);
  
  // Smart language detection
  if (/[\u0600-\u06FF]/.test(clean)) {
    utterance.lang = "ar-SA";
  } else if (/[\u4E00-\u9FFF]/.test(clean)) {
    utterance.lang = "zh-CN";
  } else if (/[áéíóúñ¿¡]/i.test(clean)) {
    utterance.lang = "es-ES";
  } else if (/[\u0400-\u04FF]/.test(clean)) {
    utterance.lang = "ru-RU";
  } else if (/[\u3040-\u30FF]/.test(clean)) {
    utterance.lang = "ja-JP";
  } else if (/[\uAC00-\uD7AF]/.test(clean)) {
    utterance.lang = "ko-KR";
  } else if (/[\u0900-\u097F]/.test(clean)) {
    utterance.lang = "hi-IN";
  } else if (/[çãõáéíóú]/i.test(clean) && !/[ñ¿¡]/.test(clean)) {
    utterance.lang = "pt-BR";
  } else {
    utterance.lang = "en-US";
  }

  utterance.rate = 0.95;
  utterance.pitch = 1;

  activeSpeechUtterance = utterance;
  activeSpeechButton = button;

  setPlayButtonActive(button);

  utterance.onend = () => {
    if (cancelledUtterances.has(utterance)) {
      cancelledUtterances.delete(utterance);
      return;
    }

    activeSpeechUtterance = null;
    activeSpeechButton = null;
    resetPlayButton(button);
  };

  utterance.onerror = () => {
    if (cancelledUtterances.has(utterance)) {
      cancelledUtterances.delete(utterance);
      return;
    }

    activeSpeechUtterance = null;
    activeSpeechButton = null;
    resetPlayButton(button);
    showToast("Could not read this response aloud.");
  };

  window.setTimeout(() => {
    if (activeSpeechUtterance === utterance) {
      window.speechSynthesis.speak(utterance);
    }
  }, 80);
}

function setPlayButtonActive(button) {
  if (!button) return;

  const icon = button.querySelector("[data-lucide]");
  icon?.setAttribute("data-lucide", "square");
  button.classList.add("text-blue-600", "dark:text-blue-400");
  refreshIcons();
}

function resetPlayButton(button) {
  if (!button) return;

  const icon = button.querySelector("[data-lucide]");
  icon?.setAttribute("data-lucide", "volume-2");
  button.classList.remove("text-blue-600", "dark:text-blue-400");
  refreshIcons();
}

function fallbackCopy(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  document.body.appendChild(textarea);
  textarea.select();

  try {
    document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

function isSafetyLock(response) {
  const level = String(response?.safety?.level || "").toLowerCase();
  const category = String(response?.safety?.user_visible_category || "").toLowerCase();

  return Boolean(
    response?.lock_session ||
    level.includes("imminent") ||
    level.includes("self_harm") ||
    category.includes("crisis") ||
    category.includes("emergency"),
  );
}

function isCrisisReply(text, safetyLevel) {
  const haystack = `${text || ""} ${safetyLevel || ""}`.toLowerCase();

  return (
    haystack.includes("emergency") ||
    haystack.includes("988") ||
    haystack.includes("nearest emergency") ||
    haystack.includes("self_harm_imminent") ||
    haystack.includes("اتصل") ||
    haystack.includes("الإسعاف")
  );
}

function resolveLocale() {
  const configured = getAppSettings().language;
  if (configured === "ar-EG") return "ar";
  if (configured === "en") return "en";

  const lang = document.documentElement.lang || navigator.language || "en";

  if (lang.toLowerCase().startsWith("ar")) return "ar";
  return "en";
}

// sleep moved to utils/dom.js

window.addEventListener("beforeunload", () => {
  authUnsubscribe?.();
});
