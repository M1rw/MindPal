import {
  loadMemoryGraph,
  saveMemoryGraph,
} from "./api.js";
import {
  getCurrentUser,
  getIdToken,
  initAuth,
} from "./auth.js";
import {
  getAppSettings,
  applyVisualSettings,
  setAppSetting,
} from "./settings_store.js";
import {
  loadMemoryGraphContext,
  memoryGraphFromBackend,
  saveMemoryGraphContext,
} from "./memory_graph.js";
import { syncMemoryGraphSnapshot } from "./memory_sync.mjs";
import {
  initBrainWorkspace,
  mountBrainWorkspace,
} from "./components/brain_workspace.js";

let memoryGraph = loadMemoryGraphContext();
let toastTimer = null;

document.addEventListener("DOMContentLoaded", () => { void bootstrapBrainPage(); });

async function bootstrapBrainPage() {
  applyVisualSettings(getAppSettings());
  bindThemeToggle();
  try {
    await initAuth();
    await hydrateBrainGraph();
  } catch (error) {
    console.warn("MindPal Brain started in local mode", error);
    setAccountLabel("Local memory");
  }

  initBrainWorkspace({
    getIdToken,
    getMemoryGraphContext: () => memoryGraph,
    setMemoryGraphContext: (nextGraph) => { memoryGraph = nextGraph; },
    persistMemoryContextSafe: persistBrainGraph,
    showToast,
    refreshIcons,
    openMemoryControls: () => { window.location.assign("/"); },
  });
  await mountBrainWorkspace();
  refreshIcons();
}

async function hydrateBrainGraph() {
  const token = await getIdToken();
  const user = getCurrentUser();
  if (!token) {
    memoryGraph = loadMemoryGraphContext();
    setAccountLabel("Local memory");
    return;
  }

  const response = await loadMemoryGraph(token);
  memoryGraph = saveMemoryGraphContext(memoryGraphFromBackend(response));
  const displayName = String(user?.displayName || user?.email || "Cloud memory").trim();
  setAccountLabel(displayName ? `Memory for ${displayName}` : "Cloud memory");
}

async function persistBrainGraph() {
  memoryGraph = saveMemoryGraphContext(memoryGraph);
  const token = await getIdToken();
  if (!token) {
    showToast("Saved on this device.");
    return;
  }

  try {
    memoryGraph = await syncMemoryGraphSnapshot(memoryGraph, {
      loadRemote: () => loadMemoryGraph(token),
      saveRemote: (graph, expectedVersion) => saveMemoryGraph(graph, token, expectedVersion),
    });
    memoryGraph = saveMemoryGraphContext(memoryGraph);
  } catch (error) {
    console.warn("Cloud Brain sync failed; retained local copy", error);
    showToast("Saved on this device. Cloud sync will retry next time.");
  }
}

function bindThemeToggle() {
  document.getElementById("brain-theme-toggle")?.addEventListener("click", () => {
    const nextAppearance = document.documentElement.classList.contains("dark") ? "light" : "dark";
    setAppSetting("appearance", nextAppearance);
  });
}

function setAccountLabel(value) {
  const target = document.getElementById("brain-account-label");
  if (target) target.textContent = value;
}

function refreshIcons() {
  try { window.lucide?.createIcons?.(); } catch (error) { console.warn("Icon refresh failed", error); }
}

function showToast(message) {
  const target = document.getElementById("brain-toast");
  if (!target) return;
  target.textContent = String(message || "");
  target.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => target.classList.remove("show"), 3200);
}
