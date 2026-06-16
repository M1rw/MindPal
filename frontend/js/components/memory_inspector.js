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

  const summaryLines = cards.map((card) => {
    const values = card.items.slice(0, 4).map((item) => item.value).join(", ");
    const more = card.items.length > 4 ? `, +${card.items.length - 4} more` : "";
    return `<li><strong>${escapeHtml(card.label)}:</strong> ${escapeHtml(values + more)}</li>`;
  }).join("");

  list.innerHTML = `
    <div class="settings-memory-summary-card">
      <div class="flex items-start justify-between gap-4">
        <div>
          <div class="font-medium text-gray-900 dark:text-white">MindPal remembers ${totalItems} durable ${totalItems === 1 ? "item" : "items"}.</div>
          <ul class="mt-3 space-y-1.5 text-[13px] leading-5 text-gray-600 dark:text-gray-300">${summaryLines}</ul>
        </div>
        <button class="settings-pill-btn memory-manage-toggle" type="button">Manage</button>
      </div>
    </div>
    <div class="settings-memory-manage hidden">
      ${cards.map((card) => `
        <div class="settings-memory-manage-card">
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
      `).join("")}
    </div>
  `;

  list.querySelector(".memory-manage-toggle")?.addEventListener("click", (event) => {
    const manage = list.querySelector(".settings-memory-manage");
    if (!manage) return;

    const isHidden = manage.classList.toggle("hidden");
    event.currentTarget.textContent = isHidden ? "Manage" : "Hide";
  });

  list.querySelectorAll(".memory-delete-btn").forEach((button) => {
    button.addEventListener("click", () => {
      deps.deleteMemoryEntry(button.getAttribute("data-memory-id") || "");
      renderMemoryInspector();
      void deps.persistMemoryContextSafe();
    });
  });

  list.querySelectorAll(".memory-edit-btn").forEach((button) => {
    button.addEventListener("click", () => {
      deps.editMemoryEntry(button.getAttribute("data-memory-id") || "");
      renderMemoryInspector();
      void deps.persistMemoryContextSafe();
    });
  });

  list.querySelectorAll(".memory-pin-btn").forEach((button) => {
    button.addEventListener("click", () => {
      deps.toggleMemoryPin(button.getAttribute("data-memory-id") || "");
      renderMemoryInspector();
      void deps.persistMemoryContextSafe();
    });
  });

  list.querySelectorAll(".memory-clear-category-btn").forEach((button) => {
    button.addEventListener("click", () => {
      deps.clearMemoryCategory(button.getAttribute("data-memory-category") || "");
      renderMemoryInspector();
      void deps.persistMemoryContextSafe();
    });
  });

  deps.refreshIcons(list);
}
