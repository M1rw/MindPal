import {
  applyVisualSettings,
  buildChatSettingsMetadata,
  buildProfilePreferencesPatch,
  getAppSettings,
  hydrateSettingsFromProfile,
  requestBrowserNotificationsIfNeeded,
  setAppSetting,
} from "../settings_store.js?v=20260615-streaming-v7";

import { escapeHtml } from "../utils/dom.js";

import {
  getIdToken
} from "../auth.js?v=20260615-streaming-v7";

import {
  updateUserProfilePreferences
} from "../api.js?v=20260615-streaming-v7";

// We will attach dependencies that require app.js state via a registry
const deps = {
  refreshIcons: () => {},
  showToast: () => {},
  openModal: () => {},
  closeModal: () => {},
  startNewLocalChat: () => {},
  handleSend: () => {},
  getCurrentUser: () => null,
  updateProfileUI: () => {},
  isGenerating: false,
  isSessionLocked: false,
  currentCloudProfileContext: null,
};

export function initSettingsUI(dependencies) {
  Object.assign(deps, dependencies);
}

const SETTINGS_SELECTS = {
  Appearance: {
    path: "appearance",
    options: [["system", "System"], ["light", "Light"], ["dark", "Dark"]],
  },
  Contrast: {
    path: "contrast",
    options: [["system", "System"], ["standard", "Standard"], ["high", "High"]],
  },
  "Accent color": {
    path: "accentColor",
    options: [["blue", "MindPal blue"], ["orange", "Orange"], ["green", "Green"]],
    accent: true,
  },
  Language: {
    path: "language",
    options: [["auto", "Auto-detect"], ["en", "English"], ["ar-EG", "Egyptian Arabic"]],
  },
  "Spoken language": {
    path: "spokenLanguage",
    options: [["auto", "Auto / Browser default"], ["en-US", "English (US)"], ["ar-EG", "Egyptian Arabic"]],
  },
  Voice: {
    path: "voicePreview",
    options: [["browser", "Preview"], ["off", "Off"]],
  },
  "Streak reminders": {
    path: "notifications.streakReminders",
    options: [["off", "Off"], ["in_app", "In app"], ["push", "Push"]],
  },
  "Response complete": {
    path: "notifications.responseComplete",
    options: [["off", "Off"], ["in_app", "In app"], ["push", "Push"]],
  },
  "Mood check-in": {
    path: "notifications.moodCheckIn",
    options: [["off", "Off"], ["in_app", "In app"], ["push", "Push"]],
  },
  "Memory updates": {
    path: "notifications.memoryUpdates",
    options: [["off", "Off"], ["in_app", "In app"], ["push", "Push"]],
  },
  "Safety follow-up": {
    path: "notifications.safetyFollowUp",
    options: [["off", "Off"], ["in_app", "In app"], ["push", "Push"]],
  },
  "Base style and tone": {
    path: "personalization.baseTone",
    options: [["concise", "Concise"], ["balanced", "Balanced"], ["detailed", "Detailed"]],
  },
  Directness: {
    path: "personalization.directness",
    options: [["low", "Low"], ["medium", "Medium"], ["high", "High"]],
  },
  "Egyptian Arabic style": {
    path: "personalization.egyptianArabic",
    options: [["auto", "Auto"], ["always", "Always"], ["off", "Off"]],
  },
};

const SETTINGS_TOGGLES = {
  "Enable dictation": "dictationEnabled",
  "Fast answers": "personalization.fastAnswers",
  "Cognitive structure": "personalization.cognitiveStructure",
  "Enable memory": "memoryEnabled",
  "Improve MindPal for everyone": "improveProduct",
};

export function readPath(source, path) {
  return String(path).split(".").reduce((cursor, part) => cursor?.[part], source);
}

let appSettingsPersistTimer = null;

export async function persistAppSettingsToCloud() {
  const token = await getIdToken();
  if (!token) return;

  if (appSettingsPersistTimer !== null) {
    window.clearTimeout(appSettingsPersistTimer);
  }

  appSettingsPersistTimer = window.setTimeout(async () => {
    appSettingsPersistTimer = null;
    try {
      const response = await updateUserProfilePreferences(buildProfilePreferencesPatch(), token);
      hydrateSettingsFromProfile(response);
      if (deps.currentCloudProfileContext) {
        deps.currentCloudProfileContext.settingsMetadata = buildChatSettingsMetadata();
      }
    } catch (error) {
      console.warn("MindPal settings sync failed:", error);
      deps.showToast("Settings saved locally. Cloud sync failed.");
    }
  }, 500);
}

export function notifyFromSetting(key, title, body) {
  const setting = getAppSettings().notifications?.[key] || "off";

  if (setting === "off") return;

  if (setting === "push" && "Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body });
    return;
  }

  deps.showToast(body || title);
}

export function renderSettingsControls(root) {
  const settings = getAppSettings();

  root.querySelectorAll(".settings-row").forEach((row) => {
    const title = row.querySelector(".settings-row-title")?.textContent?.trim();
    if (!title) return;

    const selectConfig = SETTINGS_SELECTS[title];
    const action = row.querySelector(".settings-row-action");
    const existingChoice = row.querySelector(".settings-choice");
    const nativeSelect = row.querySelector("select");
    if (selectConfig && (action || existingChoice || nativeSelect)) {
      (action || existingChoice || nativeSelect).replaceWith(createSettingsSelect(title, selectConfig, settings));
    }

    const toggle = row.querySelector("input[type='checkbox']");
    if (toggle && SETTINGS_TOGGLES[title]) {
      const path = SETTINGS_TOGGLES[title];
      toggle.setAttribute("data-setting-toggle", path);
      toggle.checked = path === "appearance" ? document.documentElement.classList.contains("dark") : Boolean(readPath(settings, path));
    }
  });

  const customBox = root.querySelector(".settings-textbox");
  if (customBox && !customBox.matches("textarea")) {
    const textarea = document.createElement("textarea");
    textarea.className = "settings-textbox settings-textarea";
    textarea.value = settings.personalization.customInstructions;
    textarea.setAttribute("data-setting-text", "personalization.customInstructions");
    textarea.setAttribute("rows", "6");
    customBox.replaceWith(textarea);
  }

  const ciTextarea = root.querySelector("textarea[data-setting-text='personalization.customInstructions']");
  if (ciTextarea) {
    let counter = ciTextarea.parentElement?.querySelector(".settings-char-counter");
    if (!counter) {
      counter = document.createElement("span");
      counter.className = "settings-char-counter";
      ciTextarea.insertAdjacentElement("afterend", counter);
      ciTextarea.addEventListener("input", () => {
        const l = ciTextarea.value.length;
        counter.textContent = `${l} / 800`;
        counter.classList.toggle("near-limit", l > 640 && l <= 780);
        counter.classList.toggle("at-limit", l > 780);
      });
    }
    const len = ciTextarea.value.length;
    counter.textContent = `${len} / 800`;
    counter.classList.toggle("near-limit", len > 640 && len <= 780);
    counter.classList.toggle("at-limit", len > 780);
  }

  applyVisualSettings(settings);
  // Defer icon refresh — don't block interaction
  const schedule = window.requestIdleCallback || ((cb) => setTimeout(cb, 120));
  schedule(() => deps.refreshIcons(document));
}

function createSettingsSelect(title, config, settings) {
  return createSettingsChoice(title, config, settings);
}

function createSettingsChoice(title, config, settings) {
  const wrapper = document.createElement("div");
  wrapper.className = "settings-choice";
  wrapper.setAttribute("data-settings-choice", config.path);

  const selectedValue = readPath(settings, config.path);
  const selectedLabel = config.options.find(([value]) => value === selectedValue)?.[1] || config.options[0]?.[1] || "";

  wrapper.insertAdjacentHTML("beforeend", `
    <button class="settings-choice-trigger" data-setting-choice-trigger="${escapeHtml(config.path)}" aria-label="${escapeHtml(title)}" aria-haspopup="listbox" aria-expanded="false" type="button">
      ${config.accent ? `<span class="settings-accent-dot" data-accent="${escapeHtml(selectedValue)}"></span>` : ""}
      <span class="settings-choice-label">${escapeHtml(selectedLabel)}</span>
      <i data-lucide="chevron-down" class="w-4 h-4"></i>
    </button>
    <div class="settings-choice-menu" role="listbox" aria-label="${escapeHtml(title)}">
      ${config.options.map(([value, label]) => `
        <button class="settings-choice-option${value === selectedValue ? " active" : ""}" data-setting-choice-option="${escapeHtml(config.path)}" data-setting-choice-value="${escapeHtml(value)}" role="option" aria-selected="${value === selectedValue}" type="button">
          <span>${escapeHtml(label)}</span>
          ${value === selectedValue ? `<i data-lucide="check" class="w-4 h-4"></i>` : ""}
        </button>
      `).join("")}
    </div>
  `);

  return wrapper;
}

export async function updateSettingFromControl(path, value, control) {
  if (!path) return;

  const normalizedValue = path === "appearance" && typeof value === "boolean"
    ? (value ? "dark" : "light")
    : value;

  setAppSetting(path, normalizedValue);

  if (path.startsWith("notifications.")) {
    const permission = await requestBrowserNotificationsIfNeeded(normalizedValue);
    if (permission === "denied") {
      setAppSetting(path, "in_app");
      if (control) control.value = "in_app";
      deps.showToast("Browser notifications are blocked. Saved as in-app.");
    } else if (permission === "unsupported") {
      setAppSetting(path, "in_app");
      if (control) control.value = "in_app";
      deps.showToast("This browser does not support notifications. Saved as in-app.");
    } else if (permission === "granted") {
      deps.showToast("Browser notifications enabled for this setting.");
    }
  }

  renderSettingsControls(document.getElementById("profile-content") || document);
  await persistAppSettingsToCloud();
}

export async function handleSettingsButtonAction(action, source = null) {
  if (action === "choice-toggle") return;

  if (source?.matches?.("[data-setting-choice-trigger]")) {
    toggleSettingsChoice(source);
    return;
  }

  if (source?.matches?.("[data-setting-choice-option]")) {
    await chooseSettingsOption(source);
    return;
  }

  if (action === "location" || action === "passkeys" || action === "sessions" || action === "archived") {
    return; // These features show "Coming soon" in the UI
  }

  if (action === "shortcut") {
    runShortcutAction(source?.getAttribute("data-shortcut-action") || "");
    return;
  }

  if (action === "restore-shortcuts") {
    deps.showToast("Keyboard shortcuts restored to defaults.");
    return;
  }

  deps.showToast("Setting is not available for this account mode yet.");
}

export function bindSettingsChoiceEvents() {
  document.addEventListener("click", async (event) => {
    const trigger = event.target.closest?.("[data-setting-choice-trigger]");
    const option = event.target.closest?.("[data-setting-choice-option]");

    if (trigger) {
      event.preventDefault();
      event.stopPropagation();
      toggleSettingsChoice(trigger);
      return;
    }

    if (option) {
      event.preventDefault();
      event.stopPropagation();
      await chooseSettingsOption(option);
      return;
    }

    closeSettingsChoices();
  });

  document.addEventListener("keydown", async (event) => {
    if (event.key === "Escape") {
      closeSettingsChoices();
      return;
    }

    const focusedOption = document.activeElement?.matches?.("[data-setting-choice-option]")
      ? document.activeElement
      : null;
    if (!focusedOption || (event.key !== "Enter" && event.key !== " ")) return;

    event.preventDefault();
    await chooseSettingsOption(focusedOption);
  });
}

export function bindSettingsControls() {
  const modal = document.getElementById("profile-content");
  if (!modal) return;

  renderSettingsControls(modal);

  modal.addEventListener("change", async (event) => {
    const select = event.target.closest?.("[data-setting-select]");
    const toggle = event.target.closest?.("[data-setting-toggle]");
    const textbox = event.target.closest?.("[data-setting-text]");

    if (select) {
      await updateSettingFromControl(select.getAttribute("data-setting-select"), select.value, select);
      return;
    }

    if (toggle) {
      await updateSettingFromControl(toggle.getAttribute("data-setting-toggle"), toggle.checked, toggle);
      return;
    }

    if (textbox) {
      await updateSettingFromControl(textbox.getAttribute("data-setting-text"), textbox.value, textbox);
    }
  });

  modal.addEventListener("click", async (event) => {
    const button = event.target.closest?.("[data-settings-action]");
    if (!button) return;

    event.stopPropagation();
    await handleSettingsButtonAction(button.getAttribute("data-settings-action"), button);
  });
}

export function bindKeyboardShortcuts() {
  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    const command = event.ctrlKey || event.metaKey;
    const editable = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName || "");

    if (command && key === ",") {
      event.preventDefault();
      runShortcutAction("settings");
      return;
    }

    if (!command || !event.shiftKey) return;

    if (key === "d") {
      event.preventDefault();
      runShortcutAction("dictation");
      return;
    }

    if (key === "m") {
      event.preventDefault();
      runShortcutAction("mode");
      return;
    }

    if (key === "o" && !editable) {
      event.preventDefault();
      runShortcutAction("new-chat");
    }
  });
}

export function runShortcutAction(action) {
  if (action === "send") {
    if (!deps.isGenerating && !deps.isSessionLocked) {
      void deps.handleSend();
    }
    return;
  }

  if (action === "dictation") {
    if (!getAppSettings().dictationEnabled) {
      deps.showToast("Dictation is disabled in settings.");
      return;
    }
    document.getElementById("voice-btn")?.click();
    return;
  }

  if (action === "mode") {
    deps.closeModal("profile-modal", "profile-content");
    document.getElementById("mode-dropdown")?.classList.toggle("hidden");
    return;
  }

  if (action === "settings") {
    deps.updateProfileUI(deps.getCurrentUser());
    deps.openModal("profile-modal", "profile-content");
    return;
  }

  if (action === "new-chat") {
    deps.startNewLocalChat();
  }
}

export function toggleSettingsChoice(trigger) {
  const choice = trigger.closest(".settings-choice");
  if (!choice) return;

  const isOpen = choice.classList.contains("open");
  closeSettingsChoices(choice);
  choice.classList.toggle("open", !isOpen);
  trigger.setAttribute("aria-expanded", String(!isOpen));
}

export async function chooseSettingsOption(option) {
  const path = option.getAttribute("data-setting-choice-option");
  const value = option.getAttribute("data-setting-choice-value");
  if (!path) return;

  closeSettingsChoices();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await updateSettingFromControl(path, value, option);
}

export function closeSettingsChoices(except = null) {
  document.querySelectorAll(".settings-choice.open").forEach((choice) => {
    if (choice === except) return;
    choice.classList.remove("open");
    choice.querySelector("[data-setting-choice-trigger]")?.setAttribute("aria-expanded", "false");
  });
}
