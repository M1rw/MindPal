// frontend/js/cloud_sync.js — Cloud auth, memory hydration, and chat sync

import {
  getCurrentUserProfile,
  loadUserProfile,
  loadMemory,
  loadMemoryGraph,
  saveMemoryGraph,
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
} from "./auth.js";

import {
  getState,
  patchState,
  replaceChatMemory,
  setCloudSyncEnabled,
  setUserName,
  updateProfileUI,
  updateMentalHealthUI,
  updateUsageUI,
} from "./ui_state.js";

import {
  hydrateSettingsFromProfile,
  buildChatSettingsMetadata,
} from "./settings_store.js";

import {
  loadMemoryGraphContext,
  memoryGraphFromBackend,
  mergeMemoryGraphs,
  saveMemoryGraphContext,
  loadMemoryContext,
  memoryFromBackendSummary,
} from "./memory_graph.js";

import { memoryGraphAtomsEqual, syncMemoryGraphSnapshot } from "./memory_sync.mjs";

// ═══════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════

let cloudConnectInProgress = false;
let cloudChatHydratedForUser = null;
let cloudChatSyncInFlight = false;
let cloudChatSyncTimer = null;
const pendingCloudChatMessages = [];
let cloudMemorySyncTail = Promise.resolve();

let currentCloudProfileContext = null;
function loadCanonicalLocalMemory() {
  const graph = loadMemoryGraphContext();
  if (graph.atoms?.length) return graph;
  return mergeMemoryGraphs(graph, loadMemoryContext());
}

let memoryGraphContext = loadCanonicalLocalMemory();
let memoryContext = memoryGraphContext;
let authUnsubscribe = null;

// Expose for app.js orchestration
export function setMemoryContext(ctx) {
  memoryGraphContext = saveMemoryGraphContext(ctx);
  memoryContext = memoryGraphContext;
}
export function setMemoryGraphContext(ctx) {
  memoryGraphContext = saveMemoryGraphContext(ctx);
  memoryContext = memoryGraphContext;
}
export function setCurrentCloudProfileContext(ctx) { currentCloudProfileContext = ctx; }
export function getMemoryContext() { return memoryContext; }
export function getMemoryGraphContext() { return memoryGraphContext; }
export function getCurrentCloudProfileContext() { return currentCloudProfileContext; }

function queueCloudMemorySync(operation) {
  const result = cloudMemorySyncTail.catch(() => {}).then(operation);
  cloudMemorySyncTail = result.catch(() => {});
  return result;
}

// ═══════════════════════════════════════════════════════════════
// Auth initialization
// ═══════════════════════════════════════════════════════════════

export async function initFrontendAuth({ removeGlobalLoader, renderPersistedChat, renderMemoryInspector }) {
  if (!authIsConfigured()) {
    setCloudSyncEnabled(false);
    removeGlobalLoader();
    return;
  }

  let loaderRemovedByCallback = false;

  try {
    await initAuth();

    authUnsubscribe = onAuthChange(async (user) => {
      loaderRemovedByCallback = true;
      const nextUserId = user?.uid || null;
      if (cloudChatHydratedForUser && cloudChatHydratedForUser !== nextUserId) {
        cloudChatHydratedForUser = null;
        pendingCloudChatMessages.length = 0;
      }

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
        removeGlobalLoader();
        return;
      }

      try {
        const token = await getIdToken();

        if (!token) {
          throw new Error("Firebase returned no ID token.");
        }

        const profile = await getCurrentUserProfile(token);
        try {
          const profileRes = await loadUserProfile(token);
          if (profileRes) {
            hydrateSettingsFromProfile(profileRes);
            updateMentalHealthUI(profileRes);
            updateUsageUI(profileRes);
          }
        } catch (e) {
          console.error("Failed to load cloud profile:", e);
        }

        currentCloudProfileContext = {
          ...buildCloudProfileContext(user, profile),
          settingsMetadata: buildChatSettingsMetadata(),
        };
        await hydrateCloudMemory(token, renderMemoryInspector);
        await hydrateCloudChat(token, renderPersistedChat);

        setCloudSyncEnabled(true);
        updateProfileUI(user);
      } catch (error) {
        console.warn("Silent cloud profile verification failed:", error);
        currentCloudProfileContext = null;
        memoryGraphContext = loadCanonicalLocalMemory();
        memoryContext = memoryGraphContext;
        setCloudSyncEnabled(false);
        updateProfileUI(null);
      } finally {
        removeGlobalLoader();
      }
    });

    // Safety: if onAuthChange callback hasn't fired after a short delay,
    // the user is not logged in and Firebase didn't re-fire the listener.
    // Remove the loader to prevent infinite loading screen.
    setTimeout(() => {
      if (!loaderRemovedByCallback) {
        console.warn("[MindPal] Auth callback did not fire — removing loader (not logged in)");
        setCloudSyncEnabled(false);
        removeGlobalLoader();
      }
    }, 2000);

  } catch (error) {
    console.warn("Firebase frontend auth init failed:", error);
    setCloudSyncEnabled(false);
    removeGlobalLoader();
  }
}

export function cleanupAuth() {
  authUnsubscribe?.();
}

// ═══════════════════════════════════════════════════════════════
// Cloud memory
// ═══════════════════════════════════════════════════════════════

export async function hydrateCloudMemory(token, renderMemoryInspector) {
  if (!token) return;

  try {
    const localGraph = saveMemoryGraphContext(memoryGraphContext);
    const response = await loadMemoryGraph(token);
    let canonicalGraph = localGraph;

    if (response?.loaded && response.graph) {
      const cloudGraph = memoryGraphFromBackend(response.graph);
      canonicalGraph = mergeMemoryGraphs(cloudGraph, localGraph);
    } else {
      // One-time migration path only. V3 remains the sole canonical store afterward.
      const legacyResponse = await loadMemory(token).catch(() => null);
      if (legacyResponse?.loaded && legacyResponse.summary) {
        canonicalGraph = mergeMemoryGraphs(canonicalGraph, memoryFromBackendSummary(legacyResponse.summary));
      }
    }

    memoryGraphContext = saveMemoryGraphContext(canonicalGraph);
    memoryContext = memoryGraphContext;

    memoryGraphContext = await queueCloudMemorySync(() => syncMemoryGraphSnapshot(memoryGraphContext, {
      initialRemote: response?.graph || null,
      loadRemote: () => loadMemoryGraph(token),
      saveRemote: (graph, expectedVersion) => saveMemoryGraph(graph, token, expectedVersion),
    }));
    memoryGraphContext = saveMemoryGraphContext(memoryGraphContext);
    memoryContext = memoryGraphContext;
    renderMemoryInspector?.();
  } catch (error) {
    console.warn("Cloud memory hydration failed; using local memory.", error);
    memoryGraphContext = loadCanonicalLocalMemory();
    memoryContext = memoryGraphContext;
    renderMemoryInspector?.();
  }
}

// ═══════════════════════════════════════════════════════════════
// Cloud chat sync
// ═══════════════════════════════════════════════════════════════

export async function hydrateCloudChat(token, renderPersistedChat) {
  const userId = getCurrentUser()?.uid || null;
  if (!token || !userId || cloudChatHydratedForUser === userId) return;

  try {
    const response = await loadCurrentCloudChat(token);
    const cloudMessages = normalizeCloudMessages(response?.chat?.messages || []);
    const localMessages = normalizeLocalMessages(getState().chatMemory || []);
    const merged = mergeChatMessages(localMessages, cloudMessages);

    if (merged.length) {
      replaceChatMemory(merged);
      renderPersistedChat?.();
    }

    cloudChatHydratedForUser = userId;

    if (merged.length && merged.length !== cloudMessages.length) {
      await replaceCurrentCloudChat(merged, token);
    }

    await flushPendingCloudChatMessages();
  } catch (error) {
    console.warn("Cloud chat hydration failed:", error);
  }
}

export function scheduleCloudMessageSync(message) {
  if (!message || !getCurrentUser()) return;

  pendingCloudChatMessages.push(normalizeLocalMessage(message));

  if (cloudChatSyncTimer) {
    window.clearTimeout(cloudChatSyncTimer);
  }

  cloudChatSyncTimer = window.setTimeout(() => {
    flushPendingCloudChatMessages();
  }, 250);
}

export async function flushPendingCloudChatMessages() {
  if (cloudChatSyncInFlight || pendingCloudChatMessages.length === 0) return;

  const token = await getIdToken();
  if (!token) {
    scheduleCloudSyncRetry();
    return;
  }

  cloudChatSyncInFlight = true;
  try {
    const batch = pendingCloudChatMessages.slice(0, 50);
    const response = await upsertCloudChatMessages(batch, token);
    pendingCloudChatMessages.splice(0, batch.length);

    if (response?.chat?.messages) {
      const merged = mergeChatMessages(
        normalizeLocalMessages(getState().chatMemory || []),
        normalizeCloudMessages(response.chat.messages),
      );
      replaceChatMemory(merged);
    }
  } catch (error) {
    console.warn("Cloud chat sync failed; preserving queue to retry later:", error);
    scheduleCloudSyncRetry();
  } finally {
    cloudChatSyncInFlight = false;
    if (pendingCloudChatMessages.length > 0) scheduleCloudSyncRetry(100);
  }
}

function scheduleCloudSyncRetry(delayMs = 2_000) {
  if (cloudChatSyncTimer) window.clearTimeout(cloudChatSyncTimer);
  cloudChatSyncTimer = window.setTimeout(() => {
    cloudChatSyncTimer = null;
    void flushPendingCloudChatMessages();
  }, delayMs);
}

export async function replaceCloudChatSnapshotSafe(messages = null) {
  const token = await getIdToken();
  if (!token) return;

  try {
    await replaceCurrentCloudChat(normalizeLocalMessages(messages || getState().chatMemory || []), token);
  } catch (error) {
    console.warn("Cloud chat snapshot replace failed:", error);
  }
}

export async function persistMemoryContextSafe() {
  try {
    const token = await getIdToken();
    memoryGraphContext = saveMemoryGraphContext(memoryGraphContext);
    memoryContext = memoryGraphContext;
    const localSnapshot = memoryGraphContext;

    if (!token) return;

    const syncedSnapshot = await queueCloudMemorySync(() => syncMemoryGraphSnapshot(localSnapshot, {
      loadRemote: () => loadMemoryGraph(token),
      saveRemote: (graph, expectedVersion) => saveMemoryGraph(graph, token, expectedVersion),
    }));
    if (memoryGraphAtomsEqual(memoryGraphContext, localSnapshot)) {
      memoryGraphContext = saveMemoryGraphContext(syncedSnapshot);
      memoryContext = memoryGraphContext;
    }
  } catch (error) {
    console.warn("Memory sync failed; local memory retained:", error);
    memoryGraphContext = saveMemoryGraphContext(memoryGraphContext);
    memoryContext = memoryGraphContext;
  }
}

// ═══════════════════════════════════════════════════════════════
// Message normalization & merging
// ═══════════════════════════════════════════════════════════════

export function normalizeCloudMessages(messages) {
  if (!Array.isArray(messages)) return [];

  return messages
    .map((message, index) => {
      const createdAt = message.created_at || message.createdAt || new Date(0).toISOString();
      return {
      role: message.role === "User" || message.role === "user" ? "User" : "MindPal",
      text: String(message.text || message.content || "").trim(),
      messageId: message.message_id || message.messageId || stableMessageId({ ...message, createdAt, index }),
      createdAt,
      providerUsed: message.provider_used || message.providerUsed || "",
      requestId: message.request_id || message.requestId || "",
      safety: message.metadata?.safety || message.safety || null,
      ragUsed: message.metadata?.rag_used || message.metadata?.ragUsed || message.rag_used || message.ragUsed || [],
      memoryUpdated: Boolean(message.metadata?.memory_updated || message.metadata?.memoryUpdated || message.memory_updated || message.memoryUpdated),
      regenerated: Boolean(message.metadata?.regenerated || message.regenerated),
      generationTimeMs: message.metadata?.generation_time_ms || message.metadata?.generationTimeMs || message.generation_time_ms || message.generationTimeMs || null,
      syncStatus: "cloud",
      ...(message.type ? { type: message.type } : {}),
      ...(message.voiceCall ? { voiceCall: message.voiceCall } : {}),
    };
    })
    .filter((message) => message.text);
}

export function normalizeLocalMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map(normalizeLocalMessage).filter((message) => message.text);
}

export function normalizeLocalMessage(message) {
  return {
    ...message,
    role: message?.role === "User" || message?.role === "user" ? "User" : "MindPal",
    text: String(message?.text || message?.content || "").trim(),
    messageId: message?.messageId || message?.message_id || stableMessageId(message),
    createdAt: message?.createdAt || message?.created_at || new Date().toISOString(),
  };
}

export function mergeChatMessages(localMessages, cloudMessages) {
  const byId = new Map();

  for (const message of [...localMessages, ...cloudMessages]) {
    const clean = normalizeLocalMessage(message);
    if (!clean.text) continue;
    const key = clean.messageId || stableMessageId(clean);

    // Preserve voice call data (especially summary) from existing message
    // when the incoming message doesn't have it. This prevents cloud sync
    // from overwriting locally-generated summaries before they sync.
    const existing = byId.get(key);
    if (existing?.voiceCall && clean.voiceCall) {
      if (existing.voiceCall.summary && !clean.voiceCall.summary) {
        clean.voiceCall.summary = existing.voiceCall.summary;
      }
      // Preserve transcript data too — cloud normalization may strip it
      if (existing.voiceCall.userTranscript && !clean.voiceCall.userTranscript) {
        clean.voiceCall.userTranscript = existing.voiceCall.userTranscript;
      }
      if (existing.voiceCall.aiTranscript && !clean.voiceCall.aiTranscript) {
        clean.voiceCall.aiTranscript = existing.voiceCall.aiTranscript;
      }
    } else if (existing?.voiceCall && !clean.voiceCall) {
      // Cloud message lost voiceCall entirely — keep the local one
      clean.voiceCall = existing.voiceCall;
      clean.type = existing.type || clean.type;
    }

    byId.set(key, clean);
  }

  return Array.from(byId.values()).sort((a, b) => {
    const dateA = String(a.createdAt || "");
    const dateB = String(b.createdAt || "");
    if (dateA !== dateB) return dateA.localeCompare(dateB);
    return String(a.messageId || "").localeCompare(String(b.messageId || ""));
  });
}

function stableMessageId(message) {
  const seed = `${message?.role || ""}|${message?.createdAt || message?.created_at || ""}|${message?.text || message?.content || ""}|${message?.index ?? ""}`;
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(index);
    hash |= 0;
  }
  return `msg_${Math.abs(hash).toString(36)}`;
}

// ═══════════════════════════════════════════════════════════════
// Profile context builders
// ═══════════════════════════════════════════════════════════════

export function buildCloudProfileContext(user, profile = null) {
  if (!user && !profile) return null;

  const displayName = profile?.display_name || profile?.displayName || profile?.name || user?.displayName || "";
  const email = profile?.email || user?.email || "";
  const uid = profile?.uid || profile?.firebase_uid || profile?.user_id || user?.uid || "";

  if (!displayName && !email && !uid) return null;

  return { authenticated: true, displayName, email, uid };
}

export function formatCloudConnectErrorSafe(error) {
  console.error("MindPal cloud profile error:", error);

  const code = String(error?.code || "");
  const status = Number(error?.status || 0);
  const requestId = String(error?.requestId || "");
  const message = String(error?.message || "");

  if (code.includes("unauthorized-domain")) {
    return "Firebase rejected this domain. Add mindpal-demo.vercel.app to Firebase Auth authorized domains.";
  }
  if (code.includes("popup-closed-by-user")) return "Sign-in popup was closed.";
  if (code.includes("popup-blocked")) return "Browser blocked the sign-in popup.";
  if (code.includes("cancelled-popup-request")) return "Another sign-in popup was already open.";
  if (status === 401) return `Backend rejected the Firebase token: ${code || "401"}${requestId ? ` (${requestId})` : ""}.`;
  if (status === 403) return `Backend blocked this profile request: ${code || "403"}${requestId ? ` (${requestId})` : ""}.`;
  if (status === 404) return "Backend /api/user/me route was not found.";
  if (status >= 500) return `Backend /api/user/me failed with ${status}${requestId ? ` (${requestId})` : ""}. Check Vercel logs.`;
  if (code === "network_error" || message.toLowerCase().includes("failed to fetch")) {
    return "Browser could not reach /api/user/me. Check API_BASE_URL and deployment routes.";
  }

  return `Cloud profile failed${code ? `: ${code}` : ""}${message ? ` — ${message}` : ""}.`;
}

// ═══════════════════════════════════════════════════════════════
// Disconnect helpers (used by bindProfileModal in app.js)
// ═══════════════════════════════════════════════════════════════

export function resetCloudState() {
  currentCloudProfileContext = null;
  memoryGraphContext = loadCanonicalLocalMemory();
  memoryContext = memoryGraphContext;
  cloudChatHydratedForUser = null;
  pendingCloudChatMessages.length = 0;
  if (cloudChatSyncTimer) {
    window.clearTimeout(cloudChatSyncTimer);
    cloudChatSyncTimer = null;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    if (pendingCloudChatMessages.length) void flushPendingCloudChatMessages();
  });
}
