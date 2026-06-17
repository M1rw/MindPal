import { getMemoryInspectorCards } from "../memory_graph.js";
import { escapeHtml } from "../utils/dom.js";

const deps = {
  refreshIcons: () => {},
  deleteMemoryEntry: () => {},
  editMemoryEntry: () => {},
  toggleMemoryPin: () => {},
  clearMemoryCategory: () => {},
  persistMemoryContextSafe: () => {},
  getMemoryGraphContext: () => null,
};

export function initMemoryUI(dependencies) {
  Object.assign(deps, dependencies);
}

// ═══════════════════════════════════════════════════════════════
// Generate a human-readable AI-style summary from memory atoms
// ═══════════════════════════════════════════════════════════════

function generateMemorySummary(cards) {
  const parts = [];

  for (const card of cards) {
    if (!card.items.length) continue;

    const category = card.key;
    const values = card.items.map((i) => i.value);

    switch (category) {
      case "profile": {
        const nameItem = values.find((v) => /preferred name/i.test(v) || !/\s/.test(v));
        if (nameItem) {
          const clean = nameItem.replace(/^preferred name:\s*/i, "").trim();
          parts.push(`Your name is <strong>${escapeHtml(clean)}</strong>.`);
        }
        const others = values.filter((v) => v !== nameItem);
        if (others.length) parts.push(others.map(escapeHtml).join(". ") + ".");
        break;
      }
      case "people": {
        const people = values.slice(0, 4);
        const more = values.length > 4 ? ` and ${values.length - 4} more` : "";
        parts.push(`You've told me about <strong>${escapeHtml(people.join(", "))}${more}</strong>.`);
        break;
      }
      case "projects": {
        const projects = values.slice(0, 3);
        const more = values.length > 3 ? ` (+${values.length - 3} more)` : "";
        parts.push(`You're working on <strong>${escapeHtml(projects.join(", "))}${more}</strong>.`);
        break;
      }
      case "preferences": {
        const prefs = values.slice(0, 3);
        parts.push(`You prefer ${escapeHtml(prefs.join(", "))}.`);
        break;
      }
      case "avoid": {
        const avoids = values.slice(0, 3);
        parts.push(`You'd rather I avoid ${escapeHtml(avoids.join(", "))}.`);
        break;
      }
      case "patterns": {
        const patterns = values.slice(0, 2);
        parts.push(`I've noticed patterns around ${escapeHtml(patterns.join(" and "))}.`);
        break;
      }
      case "goals": {
        const goals = values.slice(0, 3);
        parts.push(`Your goals include ${escapeHtml(goals.join(", "))}.`);
        break;
      }
      case "relationship_context": {
        parts.push(`I have context about your relationships.`);
        break;
      }
      case "coping_tools": {
        const tools = values.slice(0, 2);
        parts.push(`Preferred coping tools: ${escapeHtml(tools.join(", "))}.`);
        break;
      }
      case "safety_context": {
        parts.push(`Safety context is recorded and stays private.`);
        break;
      }
      default: {
        if (values.length) parts.push(`${escapeHtml(values.slice(0, 2).join(", "))}.`);
        break;
      }
    }
  }

  return parts.join(" ");
}

// ═══════════════════════════════════════════════════════════════
// Render the summary card in the settings Memory panel
// ═══════════════════════════════════════════════════════════════

export function renderMemoryInspector() {
  const list = document.getElementById("memory-inspector-list");
  if (!list) return;

  const graphContext = deps.getMemoryGraphContext();
  if (!graphContext) return;

  const cards = getMemoryInspectorCards(graphContext);
  const totalItems = cards.reduce((sum, card) => sum + card.items.length, 0);

  if (!cards.length) {
    list.innerHTML = `
      <div class="settings-memory-empty">
        <div class="font-medium text-gray-800 dark:text-gray-100">No saved memory yet.</div>
        <div class="mt-1 text-gray-500 dark:text-gray-400">When you explicitly ask MindPal to remember something durable, it will appear here.</div>
      </div>
    `;
    return;
  }

  const summaryText = generateMemorySummary(cards);

  list.innerHTML = `
    <div class="settings-memory-summary-card">
      <p class="text-[13.5px] leading-6 text-gray-700 dark:text-gray-300">${summaryText}</p>
      <div class="flex items-center justify-between mt-4 pt-3 border-t border-gray-100 dark:border-white/5">
        <span class="text-[12px] text-gray-400 dark:text-gray-500">${totalItems} ${totalItems === 1 ? "item" : "items"} saved</span>
        <button class="memory-manage-toggle settings-pill-btn" type="button">Manage</button>
      </div>
    </div>
  `;

  list.querySelector(".memory-manage-toggle")?.addEventListener("click", () => {
    openMemoryManageModal(cards);
  });

  deps.refreshIcons(list);
}

// ═══════════════════════════════════════════════════════════════
// Memory manage modal
// ═══════════════════════════════════════════════════════════════

function openMemoryManageModal(cards) {
  // Remove any existing modal
  document.getElementById("memory-manage-modal")?.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "memory-manage-modal";
  backdrop.className = "fixed inset-0 bg-black/25 dark:bg-black/70 backdrop-blur-sm z-[55] flex items-center justify-center opacity-0 transition-opacity duration-200 p-3 sm:p-5";

  const content = document.createElement("div");
  content.className = "bg-white dark:bg-[#1f1f1f] w-full max-w-[600px] max-h-[80vh] flex flex-col rounded-2xl shadow-2xl overflow-hidden transform scale-95 transition-transform duration-200 border border-black/5 dark:border-white/10";

  // Header
  content.innerHTML = `
    <div class="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-[#303030] flex-none">
      <h2 class="text-base font-medium text-gray-900 dark:text-gray-100">Manage Memory</h2>
      <button id="memory-modal-close" class="p-2 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-full text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors" type="button">
        <i data-lucide="x" class="w-5 h-5"></i>
      </button>
    </div>
    <div class="flex-1 overflow-y-auto px-5 sm:px-6 py-4 custom-scrollbar" id="memory-modal-body">
      ${renderMemoryManageBody(cards)}
    </div>
  `;

  backdrop.appendChild(content);
  document.body.appendChild(backdrop);

  // Animate in
  requestAnimationFrame(() => {
    backdrop.style.opacity = "1";
    content.style.transform = "scale(1)";
  });

  // Close handlers
  const closeModal = () => {
    backdrop.style.opacity = "0";
    content.style.transform = "scale(0.95)";
    setTimeout(() => backdrop.remove(), 200);
  };

  backdrop.querySelector("#memory-modal-close")?.addEventListener("click", closeModal);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeModal();
  });
  document.addEventListener("keydown", function escHandler(e) {
    if (e.key === "Escape") {
      closeModal();
      document.removeEventListener("keydown", escHandler);
    }
  });

  // Bind item actions
  bindMemoryModalActions(backdrop, closeModal);
  deps.refreshIcons(backdrop);
}

function renderMemoryManageBody(cards) {
  return cards.map((card) => `
    <div class="mb-5">
      <div class="flex items-center justify-between gap-3 mb-2.5">
        <div class="text-[11px] uppercase tracking-wider font-semibold text-gray-400 dark:text-gray-500">${escapeHtml(card.label)}</div>
        <button class="memory-clear-category-btn text-[11px] text-gray-400 hover:text-rose-500 dark:text-gray-500 dark:hover:text-rose-400 transition-colors px-1.5 py-0.5 rounded" data-memory-category="${escapeHtml(card.key)}" title="Clear all ${escapeHtml(card.label)}" type="button">Clear all</button>
      </div>
      <div class="space-y-1">
        ${card.items.map((item) => `
          <div class="group flex items-center gap-2 py-1.5 px-2.5 rounded-lg hover:bg-gray-50 dark:hover:bg-white/5 transition-colors">
            <span class="flex-1 text-[13px] text-gray-800 dark:text-gray-200 truncate" title="${escapeHtml(item.value)}">${escapeHtml(item.value)}</span>
            ${item.pinned ? `<i data-lucide="pin" class="w-3 h-3 text-blue-400 flex-none"></i>` : ""}
            <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-none">
              <button class="memory-pin-btn p-1 rounded hover:bg-gray-200 dark:hover:bg-zinc-700 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors" data-memory-id="${escapeHtml(item.id)}" title="${item.pinned ? "Unpin" : "Pin"}" type="button">
                <i data-lucide="${item.pinned ? "pin-off" : "pin"}" class="w-3.5 h-3.5"></i>
              </button>
              <button class="memory-edit-btn p-1 rounded hover:bg-gray-200 dark:hover:bg-zinc-700 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors" data-memory-id="${escapeHtml(item.id)}" title="Edit" type="button">
                <i data-lucide="pencil" class="w-3.5 h-3.5"></i>
              </button>
              <button class="memory-delete-btn p-1 rounded hover:bg-rose-100 dark:hover:bg-rose-900/20 text-gray-400 hover:text-rose-600 dark:hover:text-rose-400 transition-colors" data-memory-id="${escapeHtml(item.id)}" title="Delete" type="button">
                <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
              </button>
            </div>
          </div>
        `).join("")}
      </div>
    </div>
  `).join("");
}

function bindMemoryModalActions(modal, closeAndReopen) {
  const body = modal.querySelector("#memory-modal-body");
  if (!body) return;

  const refreshModal = () => {
    const graphContext = deps.getMemoryGraphContext();
    if (!graphContext) return;
    const cards = getMemoryInspectorCards(graphContext);
    if (!cards.length) {
      closeAndReopen();
      renderMemoryInspector();
      return;
    }
    body.innerHTML = renderMemoryManageBody(cards);
    bindMemoryModalActions(modal, closeAndReopen);
    deps.refreshIcons(modal);
    // Also refresh the summary card behind the modal
    renderMemoryInspector();
  };

  body.querySelectorAll(".memory-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      deps.deleteMemoryEntry(btn.getAttribute("data-memory-id") || "");
      void deps.persistMemoryContextSafe();
      refreshModal();
    });
  });

  body.querySelectorAll(".memory-edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      deps.editMemoryEntry(btn.getAttribute("data-memory-id") || "");
      void deps.persistMemoryContextSafe();
      refreshModal();
    });
  });

  body.querySelectorAll(".memory-pin-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      deps.toggleMemoryPin(btn.getAttribute("data-memory-id") || "");
      void deps.persistMemoryContextSafe();
      refreshModal();
    });
  });

  body.querySelectorAll(".memory-clear-category-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      deps.clearMemoryCategory(btn.getAttribute("data-memory-category") || "");
      void deps.persistMemoryContextSafe();
      refreshModal();
    });
  });
}
