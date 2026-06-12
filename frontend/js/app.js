// frontend/js/app.js

import {
  buildClientFallbackReply,
  deleteMemory,
  deleteMemoryGraphItem,
  getCurrentUserProfile,
  loadMemory,
  loadMemoryGraph,
  mergeMemoryGraph,
  normalizeChatHistory,
  saveMemory,
  saveMemoryGraph,
  sendChatMessage,
  deleteCurrentCloudChat,
  loadCurrentCloudChat,
  replaceCurrentCloudChat,
  upsertCloudChatMessages,
} from "./api.js";

import {
  authIsConfigured,
  getCurrentUser,
  getIdToken,
  initAuth,
  onAuthChange,
  signInWithGoogle,
  signOut,
} from "./auth.js";

import {
  addMessage,
  appendStatusIndicator,
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
} from "./ui_state.js";

import { initVoice } from "./voice.js";

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
} from "./memory_engine.js";

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
const pendingCloudChatMessages = [];

document.addEventListener("DOMContentLoaded", bootstrap);

async function bootstrap() {
  refreshIcons();
  initializeTheme();
  loadState();

  await initFrontendAuth();

  bindTheme();
  bindProfileModal();
  bindSettingsTabs();
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

        currentCloudProfileContext = buildCloudProfileContext(user, profile);
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
      }
    });
  } catch (error) {
    console.warn("Firebase frontend auth init failed:", error);
    setCloudSyncEnabled(false);
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
  if (!token || cloudChatHydrated) return;

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
    toggleTheme();
  });

  document.getElementById("modal-theme-toggle")?.addEventListener("change", () => {
    toggleTheme();
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
    renderMemoryInspector();
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

      console.info("MindPal backend profile:", profile);

      currentCloudProfileContext = buildCloudProfileContext(user, profile);
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

function renderMemoryInspector() {
  const list = document.getElementById("memory-inspector-list");
  if (!list) return;

  const cards = getMemoryInspectorCards(memoryGraphContext);

  if (!cards.length) {
    list.innerHTML = `<div class="text-gray-400 dark:text-gray-500">No saved memory yet.</div>`;
    return;
  }

  list.innerHTML = cards.map((card) => `
    <div class="rounded-lg border border-gray-100 dark:border-gemini-darkBorder px-3 py-2">
      <div class="flex items-center justify-between gap-3 mb-2">
        <div class="text-[11px] uppercase tracking-wide text-gray-400 dark:text-gray-500">${escapeHtml(card.label)}</div>
        <button class="memory-clear-category-btn p-1 rounded-full hover:bg-gemini-surface dark:hover:bg-zinc-800 text-gray-400" data-memory-category="${escapeHtml(card.key)}" title="Clear category" type="button">
          <i data-lucide="x" class="w-3.5 h-3.5"></i>
        </button>
      </div>
      <div class="flex flex-wrap gap-1.5">
        ${card.items.map((item) => `
          <span class="inline-flex max-w-full items-center gap-1 rounded-full bg-gemini-surface dark:bg-zinc-800 px-2.5 py-1 text-[12px] text-gray-700 dark:text-gray-200">
            <span class="truncate">${escapeHtml(item.value)}</span>
            ${item.pinned ? `<i data-lucide="pin" class="w-3 h-3 text-gray-400"></i>` : ""}
            <button class="memory-pin-btn text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" data-memory-id="${escapeHtml(item.id)}" title="${item.pinned ? "Unpin memory" : "Pin memory"}" type="button">
              <i data-lucide="${item.pinned ? "pin-off" : "pin"}" class="w-3 h-3"></i>
            </button>
            <button class="memory-edit-btn text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" data-memory-id="${escapeHtml(item.id)}" title="Edit memory" type="button">
              <i data-lucide="pencil" class="w-3 h-3"></i>
            </button>
            <button class="memory-delete-btn text-rose-500 hover:text-rose-700" data-memory-id="${escapeHtml(item.id)}" title="Delete memory" type="button">
              <i data-lucide="x" class="w-3 h-3"></i>
            </button>
          </span>
        `).join("")}
      </div>
    </div>
  `).join("");

  list.querySelectorAll(".memory-delete-btn").forEach((button) => {
    button.addEventListener("click", () => {
      deleteMemoryEntry(button.getAttribute("data-memory-id") || "");
      renderMemoryInspector();
      void persistMemoryContextSafe();
    });
  });

  list.querySelectorAll(".memory-edit-btn").forEach((button) => {
    button.addEventListener("click", () => {
      editMemoryEntry(button.getAttribute("data-memory-id") || "");
      renderMemoryInspector();
      void persistMemoryContextSafe();
    });
  });

  list.querySelectorAll(".memory-pin-btn").forEach((button) => {
    button.addEventListener("click", () => {
      toggleMemoryPin(button.getAttribute("data-memory-id") || "");
      renderMemoryInspector();
      void persistMemoryContextSafe();
    });
  });

  list.querySelectorAll(".memory-clear-category-btn").forEach((button) => {
    button.addEventListener("click", () => {
      clearMemoryCategory(button.getAttribute("data-memory-category") || "");
      renderMemoryInspector();
      void persistMemoryContextSafe();
    });
  });

  refreshIcons();
}

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
      panel.classList.toggle("active", panel.getAttribute("data-settings-panel") === nextTab);
    });

    if (mobileSelect && mobileSelect.value !== nextTab) {
      mobileSelect.value = nextTab;
    }

    if (nextTab === "memory") {
      renderMemoryInspector();
    }

    refreshIcons();
  };

  buttons.forEach((button) => {
    button.addEventListener("click", () => activate(button.getAttribute("data-settings-tab") || "general"));
  });

  mobileSelect?.addEventListener("change", (event) => {
    activate(event.target.value);
  });

  activate("general");
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

function editMemoryEntry(atomId) {
  const atom = memoryGraphContext.atoms.find((item) => item.id === atomId);
  if (!atom) return;

  const next = window.prompt("Edit memory", atom.value);
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
    const confirmed = window.confirm("Clear local conversation cache and cloud memory if signed in?");

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
  appendStatusIndicator(statusId);

  try {
    const state = getState();
    const token = await getIdToken();
    const mode = document.getElementById("current-mode-text")?.textContent || "Active Listen";

    // Send clean message only. Memory/context managed by backend via system prompt.
    const response = await sendChatMessage({
      message: outboundMessage,
      history: state.chatMemory,
      locale: resolveLocale(),
      mode,
      token,
      profileContext: currentCloudProfileContext,
    });

    removeStatusIndicator(statusId);

    const reply = String(response?.reply || "").trim();

    if (!reply) {
      throw new Error("Backend returned empty reply.");
    }

    if (isSafetyLock(response)) {
      isSessionLocked = true;
      voiceController?.setLocked(true);
    }

    const assistantMessageRecord = addMessage("MindPal", reply, {
      requestId: response.request_id || null,
      providerUsed: response.provider_used || null,
      safety: response.safety || null,
      ragUsed: response.rag_used || [],
      memoryUpdated: Boolean(response.memory_updated),
    });

    scheduleCloudMessageSync(assistantMessageRecord);

    if (response.memory_summary) {
      memoryContext = saveMemoryContext(
        mergeMemoryContexts(memoryContext, memoryFromBackendSummary(response.memory_summary)),
      );
    }

    if (response.memory_graph_snapshot && response.memory_graph_full_snapshot) {
      memoryGraphContext = saveMemoryGraphContext(memoryGraphFromBackend(response.memory_graph_snapshot));
    } else if (response.memory_graph_delta) {
      memoryGraphContext = saveMemoryGraphContext(
        mergeMemoryGraphs(memoryGraphContext, memoryGraphFromBackend(response.memory_graph_delta)),
      );
    }

    if (response.memory_summary || response.memory_graph_snapshot || response.memory_graph_delta) {
      renderMemoryInspector();
    }

    await appendMessageToUI(reply, "bot", {
      smoothScroll: true,
      typewriter: true,
      backendMeta: response,
    });
  } catch (error) {
    console.error(error);
    removeStatusIndicator(statusId);

    const fallback = buildClientFallbackReply(error);

    const fallbackMessageRecord = addMessage("MindPal", fallback, {
      providerUsed: "client_fallback",
      errorCode: error?.code || "frontend_error",
    });

    scheduleCloudMessageSync(fallbackMessageRecord);

    await appendMessageToUI(fallback, "bot", {
      smoothScroll: true,
      typewriter: true,
    });
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

  scrollChatToBottom("auto");
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
    msgDiv.className = "flex gap-4 w-full justify-end animate-fade-in";
    msgDiv.innerHTML = `
      <div class="bg-gemini-surface dark:bg-gemini-darkSurface text-gemini-text dark:text-gemini-darkText px-5 py-3 rounded-[24px] max-w-[80%] text-[15px] leading-relaxed">
        ${escapeHtml(text)}
      </div>
    `;

    chatHistory.appendChild(msgDiv);

    if (smoothScroll) scrollChatToBottom("smooth");
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
    scrollChatToBottom("smooth");
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
  appendStatusIndicator(statusId);

  try {
    const token = await getIdToken();
    const mode = document.getElementById("current-mode-text")?.textContent || "Active Listen";

    // Send clean message only. Memory/context managed by backend via system prompt.
    const response = await sendChatMessage({
      message: userMessage,
      history: messages.slice(0, userIndex),
      locale: resolveLocale(),
      mode,
      token,
      profileContext: currentCloudProfileContext,
    });

    removeStatusIndicator(statusId);

    const reply = String(response?.reply || "").trim();

    if (!reply) {
      throw new Error("Backend returned empty reply.");
    }

    if (isSafetyLock(response)) {
      isSessionLocked = true;
      voiceController?.setLocked(true);
    }

    const regeneratedRecord = addMessage("MindPal", reply, {
      requestId: response.request_id || null,
      providerUsed: response.provider_used || null,
      safety: response.safety || null,
      ragUsed: response.rag_used || [],
      memoryUpdated: Boolean(response.memory_updated),
      regenerated: true,
    });

    scheduleCloudMessageSync(regeneratedRecord);

    if (response.memory_summary) {
      memoryContext = saveMemoryContext(
        mergeMemoryContexts(memoryContext, memoryFromBackendSummary(response.memory_summary)),
      );
    }

    if (response.memory_graph_snapshot && response.memory_graph_full_snapshot) {
      memoryGraphContext = saveMemoryGraphContext(memoryGraphFromBackend(response.memory_graph_snapshot));
    } else if (response.memory_graph_delta) {
      memoryGraphContext = saveMemoryGraphContext(
        mergeMemoryGraphs(memoryGraphContext, memoryGraphFromBackend(response.memory_graph_delta)),
      );
    }

    if (response.memory_summary || response.memory_graph_snapshot || response.memory_graph_delta) {
      renderMemoryInspector();
    }

    await appendMessageToUI(reply, "bot", {
      smoothScroll: true,
      typewriter: true,
      backendMeta: response,
    });
  } catch (error) {
    console.error(error);
    removeStatusIndicator(statusId);

    const fallback = buildClientFallbackReply(error);

    const regeneratedFallbackRecord = addMessage("MindPal", fallback, {
      providerUsed: "client_fallback",
      errorCode: error?.code || "frontend_regenerate_error",
      regenerated: true,
    });

    scheduleCloudMessageSync(regeneratedFallbackRecord);

    await appendMessageToUI(fallback, "bot", {
      smoothScroll: true,
      typewriter: true,
    });
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

function processStructuredResponse(text) {
  const sections = parseCognitiveSections(text);
  const hasCognitiveStructure =
    Boolean(sections.reframe || sections.action) &&
    Boolean(sections.thought || sections.distortion || sections.evidenceFor || sections.evidenceAgainst);

  if (!hasCognitiveStructure) {
    return {
      timelineHtml: "",
      finalHtml: formatMarkdown(text),
    };
  }

  const thought = sections.thought;
  const distortion = sections.distortion;
  const evidenceFor = sections.evidenceFor;
  const evidenceAgainst = sections.evidenceAgainst;
  const reframe = sections.reframe;
  const action = sections.action;

  if (!reframe) {
    return {
      timelineHtml: "",
      finalHtml: formatMarkdown(text),
    };
  }

  const timelineHtml = `
    <div class="thought-accordion group mb-5">
      <div class="accordion-header flex items-center gap-2 cursor-pointer text-[15px] text-[#444746] dark:text-[#c4c7c5] hover:text-gray-900 dark:hover:text-white font-medium select-none transition-colors w-fit">
        <span class="collapsed-text">Thought for a few seconds</span>
        <span class="expanded-text hidden">Analyzed cognitive patterns</span>
        <i data-lucide="chevron-right" class="w-4 h-4 transition-transform duration-300 transform chevron-icon"></i>
      </div>

      <div class="accordion-content max-h-0 opacity-0 transition-all duration-300 ease-in-out overflow-hidden">
          <div class="mt-4 ml-[7px] pl-6 border-l border-gray-200 dark:border-[#444746] space-y-5 text-[15px] text-gray-700 dark:text-gray-300 relative pb-4">
            ${thought ? timelineItem("Thought", thought, "circle-minus") : ""}
            ${distortion ? timelineItem("Distortion", distortion, "circle-minus") : ""}
            ${evidenceFor ? timelineItem("Evidence For", evidenceFor, "circle-minus") : ""}
            ${evidenceAgainst ? timelineItem("Evidence Against", evidenceAgainst, "circle-minus") : ""}
            ${timelineItem("Done", "", "check-circle-2")}
          </div>
      </div>
    </div>
  `;

  let finalHtml = `<div class="text-[15px] leading-relaxed mb-4">${formatMarkdown(reframe)}</div>`;

  if (action) {
    finalHtml += `<div class="mt-4"><strong class="text-gray-900 dark:text-white font-semibold">Next Action:</strong> ${formatMarkdown(action)}</div>`;
  }

  return { timelineHtml, finalHtml };
}

function timelineItem(title, body, icon, bodyIsHtml = false) {
  return `
    <div class="relative">
      <div class="absolute -left-[33px] top-0 bg-gemini-bg dark:bg-gemini-darkBg py-1">
        <i data-lucide="${icon}" class="w-4 h-4 text-gray-400 dark:text-[#c4c7c5]"></i>
      </div>
      <div class="leading-relaxed">
        <strong class="text-gray-900 dark:text-white font-semibold">${escapeHtml(title)}${body ? ":" : ""}</strong>
        ${body ? (bodyIsHtml ? body : formatMarkdown(body)) : ""}
      </div>
    </div>
  `;
}

function parseCognitiveSections(text) {
  const sections = {
    thought: "",
    distortion: "",
    evidenceFor: "",
    evidenceAgainst: "",
    reframe: "",
    action: "",
  };

  const clean = String(text || "").replace(/\r\n/g, "\n").trim();

  if (!clean) return sections;

  const labelToKey = {
    thought: "thought",
    "core thought": "thought",
    distortion: "distortion",
    "distortion detected": "distortion",
    "evidence for": "evidenceFor",
    "evidence against": "evidenceAgainst",
    "balanced reframe": "reframe",
    "next tiny action": "action",
    "next action": "action",
  };

  const labelPattern = [
    "Balanced Reframe",
    "Evidence Against",
    "Evidence For",
    "Next Tiny Action",
    "Distortion Detected",
    "Core Thought",
    "Next Action",
    "Distortion",
    "Thought",
  ].join("|");

  const headingRegex = new RegExp(
    `^\\s*(?:[-*]\\s*)?(?:\\*\\*)?\\s*(${labelPattern})(?=\\s|:|\\*|$)\\s*(?::\\s*)?(?:\\*\\*)?\\s*`,
    "gim",
  );

  const matches = [];
  let match;

  while ((match = headingRegex.exec(clean)) !== null) {
    const label = String(match[1] || "").toLowerCase();
    const key = labelToKey[label];

    if (!key) continue;

    matches.push({
      key,
      index: match.index,
      contentStart: headingRegex.lastIndex,
    });
  }

  matches.sort((a, b) => a.index - b.index);

  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];

    const value = clean
      .slice(current.contentStart, next ? next.index : clean.length)
      .trim();

    if (value && !sections[current.key]) {
      sections[current.key] = value;
    }
  }

  return sections;
}

function cognitiveSectionKey(label) {
  const normalized = String(label || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  switch (normalized) {
    case "thought":
    case "core thought":
      return "thought";
    case "distortion":
    case "distortion detected":
      return "distortion";
    case "evidence for":
      return "evidenceFor";
    case "evidence against":
      return "evidenceAgainst";
    case "balanced reframe":
      return "reframe";
    case "next tiny action":
    case "next action":
      return "action";
    default:
      return "";
  }
}

function appendSectionLine(currentValue, line) {
  const clean = String(line || "").trim();

  if (!clean) return currentValue;

  return currentValue ? `${currentValue}\n${clean}` : clean;
}

function bindAccordion(root) {
  const header = root.querySelector(".accordion-header");
  if (!header) return;

  header.addEventListener("click", () => {
    const content = header.nextElementSibling;
    const chevron = header.querySelector(".chevron-icon");
    const collapsedText = header.querySelector(".collapsed-text");
    const expandedText = header.querySelector(".expanded-text");

    // Use max-h-0 to check if collapsed (more reliable than grid-rows)
    const isOpen = !content?.classList.contains("max-h-0");

    if (isOpen) {
      content.classList.remove("max-h-screen", "opacity-100");
      content.classList.add("max-h-0", "opacity-0");
      chevron?.classList.remove("rotate-90");
      collapsedText?.classList.remove("hidden");
      expandedText?.classList.add("hidden");
    } else {
      content?.classList.remove("max-h-0", "opacity-0");
      content?.classList.add("max-h-screen", "opacity-100");
      chevron?.classList.add("rotate-90");
      collapsedText?.classList.add("hidden");
      expandedText?.classList.remove("hidden");
    }
  });
}

async function typewriteHTML(element, html, scrollContainer) {
  element.innerHTML = "";

  const tokens = html.match(/(<[^>]+>|[^<]+)/g) || [];
  let currentHTML = "";

  for (const token of tokens) {
    if (token.startsWith("<")) {
      currentHTML += token;
      element.innerHTML = currentHTML;
      continue;
    }

    for (let index = 0; index < token.length; index += 1) {
      currentHTML += token.charAt(index);
      element.innerHTML = currentHTML;

      if (index % 3 === 0) {
        scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: "auto" });
      }

      await sleep(6);
    }
  }

  scrollChatToBottom("smooth");
}

function formatMarkdown(text) {
  const escaped = escapeHtml(text);

  return escaped
    .replace(/\*\*(.*?)\*\*/g, '<strong class="text-gray-900 dark:text-gray-100 font-semibold">$1</strong>')
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/\n\n/g, "<br><br>")
    .replace(/\n/g, "<br>");
}

function stripMarkdown(text) {
  return String(text || "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1");
}

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
  utterance.lang = resolveLocale() === "ar" ? "ar-EG" : "en-US";
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
  const lang = document.documentElement.lang || navigator.language || "en";

  if (lang.toLowerCase().startsWith("ar")) return "ar";
  return "en";
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

window.addEventListener("beforeunload", () => {
  authUnsubscribe?.();
});
