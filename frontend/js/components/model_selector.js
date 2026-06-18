// frontend/js/components/model_selector.js — Unified Model + Mode selector

import { refreshIcons } from "../utils/icons.js";
import { escapeHtml, scrollChatToBottom } from "../ui_state.js";

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

const STORAGE_KEY_MODEL = "mindpal_selected_model";
const STORAGE_KEY_MODE = "mindpal_selected_mode";
const VALID_MODELS = ["standard", "pro"];
const VALID_MODES = ["Active Listen", "Guided Coach", "Cognitive Tools"];
const MODEL_SPECS = {
  standard: "Fast, warm peer-support model. Safety-first with low latency. Best for everyday check-ins and emotional support.",
  pro: "Advanced clinical reasoning with 6-step agent chain. Deep pattern analysis, nervous system assessment, and self-review. Uses 2× message quota.",
};

// ═══════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════

let _currentModel = "standard";
let _currentMode = "Active Listen";

export function getCurrentModel() { return _currentModel; }
export function getCurrentMode() { return _currentMode; }

// ═══════════════════════════════════════════════════════════════
// Persistence
// ═══════════════════════════════════════════════════════════════

function _persistedModel() {
  try {
    const v = localStorage.getItem(STORAGE_KEY_MODEL);
    return VALID_MODELS.includes(v) ? v : "standard";
  } catch { return "standard"; }
}

function _persistedMode() {
  try {
    const v = localStorage.getItem(STORAGE_KEY_MODE);
    return VALID_MODES.includes(v) ? v : "Active Listen";
  } catch { return "Active Listen"; }
}

// ═══════════════════════════════════════════════════════════════
// UI updates
// ═══════════════════════════════════════════════════════════════

function _updateUnifiedLabel() {
  const label = document.getElementById("unified-selector-label");
  if (label) {
    const modelName = _currentModel === "pro" ? "Pro" : "Standard";
    label.textContent = `${modelName} · ${_currentMode}`;
  }
}

function _updateCheckmarks() {
  document.querySelectorAll(".model-option").forEach(btn => {
    const check = btn.querySelector(".model-check");
    if (check) check.classList.toggle("hidden", btn.getAttribute("data-model") !== _currentModel);
  });
  document.querySelectorAll(".mode-option").forEach(btn => {
    const check = btn.querySelector(".mode-check");
    if (check) check.classList.toggle("hidden", btn.getAttribute("data-mode") !== _currentMode);
  });
}

function _emitSwitchIndicator(text) {
  const chatHistory = document.getElementById("chat-history");
  if (!chatHistory) return;
  const lastChild = chatHistory.lastElementChild;
  if (lastChild && lastChild.classList.contains("mode-switch-indicator")) {
    const span = lastChild.querySelector('.indicator-text');
    if (span) span.textContent = text;
  } else {
    const div = document.createElement("div");
    div.className = "mode-switch-indicator flex items-center justify-center w-full my-4 opacity-70";
    div.innerHTML = `
      <div class="h-px bg-gray-300 dark:bg-gray-700 flex-grow max-w-[100px]"></div>
      <span class="indicator-text text-xs text-gray-500 dark:text-gray-400 px-3 tracking-wide">${escapeHtml(text)}</span>
      <div class="h-px bg-gray-300 dark:bg-gray-700 flex-grow max-w-[100px]"></div>
    `;
    chatHistory.appendChild(div);
    scrollChatToBottom("smooth");
  }
}

// ═══════════════════════════════════════════════════════════════
// Selection logic
// ═══════════════════════════════════════════════════════════════

function _selectModel(model, silent = false) {
  if (!VALID_MODELS.includes(model)) return;

  if (model === "pro" && !sessionStorage.getItem("mindpal_pro_confirmed")) {
    _showProConfirmationDialog(() => {
      sessionStorage.setItem("mindpal_pro_confirmed", "1");
      _selectModel("pro", silent);
    });
    return;
  }

  _currentModel = model;
  try { localStorage.setItem(STORAGE_KEY_MODEL, model); } catch {}
  _updateUnifiedLabel();
  _updateCheckmarks();

  if (!silent) {
    const name = model === "pro" ? "Pro" : "Standard";
    _emitSwitchIndicator(`Model switched to ${name}`);
  }
}

function _selectMode(mode, silent = false) {
  if (!VALID_MODES.includes(mode)) return;
  _currentMode = mode;
  try { localStorage.setItem(STORAGE_KEY_MODE, mode); } catch {}
  _updateUnifiedLabel();
  _updateCheckmarks();

  if (!silent) {
    _emitSwitchIndicator(`Mode switched to ${mode}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Pro confirmation dialog
// ═══════════════════════════════════════════════════════════════

function _showProConfirmationDialog(onConfirm) {
  document.getElementById("pro-confirm-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "pro-confirm-overlay";
  overlay.className = "fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm";
  overlay.style.animation = "fadeIn 0.2s ease";
  overlay.innerHTML = `
    <div class="bg-white dark:bg-[#1e1f20] rounded-2xl shadow-2xl max-w-md w-[90%] p-6" style="animation: scaleIn 0.25s ease">
      <h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-1">Switch to MindPal Pro</h3>
      <p class="text-xs text-gray-500 dark:text-gray-400 mb-5">Clinical AI Mode</p>

      <div class="flex items-start gap-2.5 text-sm text-amber-600 dark:text-amber-400 mb-5 p-3 rounded-xl bg-amber-50 dark:bg-amber-900/15">
        <i data-lucide="alert-triangle" class="w-4 h-4 mt-0.5 flex-shrink-0"></i>
        <span>This is an AI assistant, not a real doctor. It may make mistakes. Always consult a licensed professional for medical decisions.</span>
      </div>

      <label class="flex items-center justify-between cursor-pointer mb-5 select-none" id="pro-confirm-toggle-label">
        <span class="text-sm text-gray-700 dark:text-gray-300 font-medium">I understand the risks</span>
        <div class="relative">
          <input type="checkbox" id="pro-confirm-toggle" class="sr-only peer">
          <div class="w-11 h-6 bg-gray-200 dark:bg-gray-700 rounded-full peer-checked:bg-red-500 transition-colors"></div>
          <div class="absolute left-0.5 top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform peer-checked:translate-x-5"></div>
        </div>
      </label>

      <div class="flex gap-3">
        <button id="pro-confirm-cancel" class="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 rounded-xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">
          Cancel
        </button>
        <button id="pro-confirm-accept" disabled class="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-red-400 rounded-xl transition-colors cursor-not-allowed opacity-60">
          Confirm Switch
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  refreshIcons();

  const toggle = document.getElementById("pro-confirm-toggle");
  const acceptBtn = document.getElementById("pro-confirm-accept");

  toggle?.addEventListener("change", () => {
    if (toggle.checked) {
      acceptBtn.disabled = false;
      acceptBtn.classList.remove("bg-red-400", "cursor-not-allowed", "opacity-60");
      acceptBtn.classList.add("bg-red-600", "hover:bg-red-700", "shadow-lg", "shadow-red-500/20", "cursor-pointer");
    } else {
      acceptBtn.disabled = true;
      acceptBtn.classList.add("bg-red-400", "cursor-not-allowed", "opacity-60");
      acceptBtn.classList.remove("bg-red-600", "hover:bg-red-700", "shadow-lg", "shadow-red-500/20", "cursor-pointer");
    }
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.getElementById("pro-confirm-cancel").addEventListener("click", () => overlay.remove());

  acceptBtn.addEventListener("click", () => {
    if (acceptBtn.disabled) return;
    overlay.remove();
    onConfirm();
  });
}

// ═══════════════════════════════════════════════════════════════
// Bind (called from bootstrap)
// ═══════════════════════════════════════════════════════════════

export function bindUnifiedSelector({ isSessionLocked, isGenerating } = {}) {
  _currentModel = _persistedModel();
  _currentMode = _persistedMode();
  _updateUnifiedLabel();
  _updateCheckmarks();

  const btn = document.getElementById("unified-selector-btn");
  const dropdown = document.getElementById("unified-dropdown");
  const chevron = document.getElementById("unified-chevron");

  function openDropdown() {
    dropdown?.classList.remove("hidden");
    btn?.setAttribute("aria-expanded", "true");
    chevron?.classList.add("rotate-180");
    const first = dropdown?.querySelector('[role="menuitem"]');
    first?.focus();
  }

  function closeDropdown() {
    dropdown?.classList.add("hidden");
    btn?.setAttribute("aria-expanded", "false");
    chevron?.classList.remove("rotate-180");
  }

  btn?.addEventListener("click", (e) => {
    if (isSessionLocked?.() || isGenerating?.()) return;
    e.stopPropagation();
    if (dropdown?.classList.contains("hidden")) {
      openDropdown();
    } else {
      closeDropdown();
    }
  });

  document.addEventListener("click", (e) => {
    if (!dropdown || !btn) return;
    if (!dropdown.contains(e.target) && !btn.contains(e.target)) {
      closeDropdown();
    }
  });

  document.querySelectorAll(".model-option").forEach(option => {
    option.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isGenerating?.()) return;
      const model = option.getAttribute("data-model");
      _selectModel(model);
      if (!isSessionLocked?.()) document.getElementById("chat-input")?.focus();
    });
  });

  // Prevent tooltip icon clicks from selecting the model
  document.querySelectorAll(".model-tooltip-wrap").forEach(wrap => {
    wrap.addEventListener("click", (e) => e.stopPropagation());
  });

  document.querySelectorAll(".mode-option").forEach(option => {
    option.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isGenerating?.()) return;
      const mode = option.getAttribute("data-mode");
      _selectMode(mode);
      closeDropdown();
      if (!isSessionLocked?.()) document.getElementById("chat-input")?.focus();
    });
  });

  // Keyboard navigation (a11y)
  dropdown?.addEventListener("keydown", (e) => {
    const items = [...dropdown.querySelectorAll('[role="menuitem"]')];
    const current = document.activeElement;
    const idx = items.indexOf(current);

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = items[(idx + 1) % items.length];
      next?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = items[(idx - 1 + items.length) % items.length];
      prev?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeDropdown();
      btn?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      current?.click();
    }
  });
}
