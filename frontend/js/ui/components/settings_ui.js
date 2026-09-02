import {
  applyVisualSettings,
  buildChatSettingsMetadata,
  buildProfilePreferencesPatch,
  getAppSettings,
  hydrateSettingsFromProfile,
  registerGenderSetter,
  requestBrowserNotificationsIfNeeded,
  saveGenderToLocal,
  setAppSetting,
} from "../../state/settings_store.js";

import { setCrisisMode } from "../../state/ui_state.js";

import { escapeHtml, formatMarkdown, sanitizeRichHtml } from "../../utils/dom.js";

import {
  getIdToken
} from "../../services/auth.js";

import {
  updateUserProfilePreferences
} from "../../services/api.js";

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
  // Wire up the gender setter so settings_store can update our _genderValue
  registerGenderSetter(setGenderValue);
}

const SETTINGS_SELECTS = {
  Appearance: {
    path: "appearance",
    options: [["system", "System"], ["light", "Light"], ["dark", "Dark"]],
  },
  Language: {
    path: "language",
    options: [["auto", "Auto-detect"], ["en", "English"], ["ar-EG", "Arabic"]],
  },
  Gender: {
    path: "gender",
    options: [["", "Not set"], ["male", "Male"], ["female", "Female"]],
    isProfileSetting: true,
  },
  "Voice model": {
    path: "voice.model",
    options: [["advanced", "Advanced"], ["standard", "Standard"], ["live", "Live"]],
  },
  "Voice language": {
    path: "voice.language",
    options: [["auto", "Auto-detect"], ["en", "English"], ["ar", "Arabic"]],
  },
  "Base style & tone": {
    path: "personalization.baseStyle",
    options: [["friendly", "Friendly"], ["default", "Default"], ["candid", "Candid"], ["quirky", "Quirky"], ["professional", "Professional"]],
  },
  "Warmth & empathy": {
    path: "personalization.warmth",
    options: [["high", "High"], ["default", "Default"], ["low", "Low"]],
  },
  "Response complete": {
    path: "notifications.responseComplete",
    options: [["off", "Off"], ["in_app", "In app"], ["push", "Push"]],
  },
  "Streak reminders": {
    path: "notifications.streakReminders",
    options: [["off", "Off"], ["in_app", "In app"], ["push", "Push"]],
  },
  "Mood check-in": {
    path: "notifications.moodCheckIn",
    options: [["off", "Off"], ["in_app", "In app"], ["push", "Push"]],
  },
};

const SETTINGS_TOGGLES = {
  "Enable dictation": "dictationEnabled",
  "Enable memory": "memoryEnabled",
  "Improve MindPal for everyone": "improveProduct",
  "Crisis interception": "crisisInterception",
  "Use headers & lists": "personalization.useHeadersLists",
  "Emoji support": "personalization.emojiSupport",
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
      // For profile settings (like gender), inject the stored value into settings
      const effectiveSettings = selectConfig.isProfileSetting
        ? { ...settings, [selectConfig.path]: _genderValue }
        : settings;
      (action || existingChoice || nativeSelect).replaceWith(createSettingsSelect(title, selectConfig, effectiveSettings));
    }

    const toggle = row.querySelector("input[type='checkbox']");
    if (toggle && SETTINGS_TOGGLES[title]) {
      const path = SETTINGS_TOGGLES[title];
      toggle.setAttribute("data-setting-toggle", path);
      toggle.checked = path === "appearance" ? document.documentElement.classList.contains("dark") : Boolean(readPath(settings, path));
    }
  });

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

  const triggerAriaLabel = `${title}: ${selectedLabel}`;

  wrapper.insertAdjacentHTML("beforeend", `
    <button class="settings-choice-trigger" data-setting-choice-trigger="${escapeHtml(config.path)}" aria-label="${escapeHtml(triggerAriaLabel)}" aria-haspopup="listbox" aria-expanded="false" type="button">
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

  // Gender is a profile setting, not an app setting
  if (path === "gender") {
    await _handleGenderUpdate(value || null);
    return;
  }

  const normalizedValue = path === "appearance" && typeof value === "boolean"
    ? (value ? "dark" : "light")
    : value;

  setAppSetting(path, normalizedValue);

  if (path === "crisisInterception") {
    setCrisisMode(Boolean(normalizedValue));
    deps.showToast(
      normalizedValue
        ? "Crisis UI interception enabled. Backend safety is always active."
        : "Crisis UI interception disabled. Backend safety is still active."
    );
  }

  if (path === "improveProduct") {
    try {
      const token = await getIdToken();
      if (token) {
        await fetch("/api/user/improvement-signals", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ opt_in: Boolean(normalizedValue) }),
        });
      }
    } catch (err) {
      console.warn("Failed to sync product improvement preference:", err);
    }
  }

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

  // Only re-render the specific dropdown that changed, not the whole panel
  const updatedSettings = getAppSettings();
  const choiceWrapper = document.querySelector(`[data-settings-choice="${path}"]`);
  if (choiceWrapper) {
    // Find matching SETTINGS_SELECTS entry
    const matchEntry = Object.entries(SETTINGS_SELECTS).find(([, cfg]) => cfg.path === path);
    if (matchEntry) {
      const [title, config] = matchEntry;
      const newChoice = createSettingsSelect(title, config, updatedSettings);
      choiceWrapper.replaceWith(newChoice);
      // Immediately render icons for the new dropdown only
      deps.refreshIcons(newChoice);
    }
  }

  // Sync the header theme icon immediately
  applyVisualSettings(updatedSettings);

  await persistAppSettingsToCloud();
  renderAnalyticsChart();
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

  if (action === "voice-preview") {
    const settings = getAppSettings();
    const voiceLang = settings.voice?.language || settings.language || "auto";
    const sampleText = voiceLang.startsWith("ar")
      ? "مرحباً، أنا مايند بال، أنا هنا دائماً للتحدث معك."
      : "Hello! I am MindPal, here whenever you want to talk.";

    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(sampleText);
      if (voiceLang !== "auto") {
        utterance.lang = voiceLang === "ar" ? "ar-EG" : voiceLang === "en" ? "en-US" : voiceLang;
      }
      window.speechSynthesis.speak(utterance);
      deps.showToast("Playing voice sample preview...");
    } else {
      deps.showToast("Voice preview is not supported on this browser.");
    }
    return;
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

function renderAnalyticsChart() {
  const chart = document.getElementById("analytics-activity-chart");
  if (!chart) return;

  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const activityData = [
    { day: "Mon", count: 3, height: "35%" },
    { day: "Tue", count: 5, height: "60%" },
    { day: "Wed", count: 4, height: "48%" },
    { day: "Thu", count: 8, height: "90%" },
    { day: "Fri", count: 6, height: "72%" },
    { day: "Sat", count: 3, height: "38%" },
    { day: "Sun", count: 9, height: "98%" },
  ];

  chart.innerHTML = activityData.map((d) => `
    <div class="flex-1 flex flex-col items-center gap-1.5 h-full justify-end group cursor-pointer">
      <div class="w-full bg-purple-500/30 group-hover:bg-purple-500/60 transition-all rounded-t" style="height: ${d.height}" title="${d.day}: ${d.count} reflections"></div>
      <span class="text-[11px] text-gray-400 group-hover:text-gray-200 transition-colors">${d.day}</span>
    </div>
  `).join("");
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
    if (button) {
      event.stopPropagation();
      await handleSettingsButtonAction(button.getAttribute("data-settings-action"), button);
      return;
    }

    if (event.target.closest("#memory-refresh-btn")) {
      await refreshMemoryV4Summary();
      return;
    }

    if (event.target.closest("#memory-apply-edit-btn")) {
      const input = document.getElementById("memory-edit-input");
      if (input && input.value.trim()) {
        await editMemoryV4Summary(input.value.trim());
        input.value = "";
      }
      return;
    }

    if (event.target.closest("#memory-reset-btn")) {
      await resetMemoryV4Summary();
      return;
    }

    if (event.target.closest("#memory-delete-all-btn")) {
      await deleteAllMemoriesV4();
    }
  });

  // Load memory summary whenever memory panel is shown
  modal.querySelectorAll("[data-settings-tab='memory']").forEach((tab) => {
    tab.addEventListener("click", () => void loadMemoryV4Data());
  });

  // Render analytics chart when analytics tab is clicked
  modal.querySelectorAll("[data-settings-tab='analytics']").forEach((tab) => {
    tab.addEventListener("click", () => renderAnalyticsChart());
  });
}

async function loadMemoryV4Data() {
  const summaryContent = document.getElementById("memory-narrative-content");
  const updatedLabel = document.getElementById("memory-last-updated");

  try {
    const token = await getIdToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};

    const summaryRes = await fetch("/api/memory/summary", { headers });
    if (summaryRes.ok) {
      const data = await summaryRes.json();
      const timeStr = data.last_updated_at ? new Date(data.last_updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'recently';
      const updatedText = `Updated ${timeStr}`;
      if (summaryContent) {
        summaryContent.innerHTML = sanitizeRichHtml(formatMarkdown(data.summary_text));
        const isRtl = data.detected_language && data.detected_language.startsWith("ar");
        summaryContent.setAttribute("dir", isRtl ? "rtl" : "ltr");
        summaryContent.setAttribute("data-detected-lang", data.detected_language || "en");
      }
      if (updatedLabel) updatedLabel.textContent = updatedText;
    }
  } catch (err) {
    console.warn("Failed to load Memory data:", err);
  }
}

async function editMemoryV4Summary(instruction) {
  try {
    deps.showToast("Updating memory profile...");
    const token = await getIdToken();
    const headers = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const res = await fetch("/api/memory/summary", {
      method: "PUT",
      headers,
      body: JSON.stringify({ instruction, action: "update" }),
    });
    if (res.ok) {
      deps.showToast("Memory profile updated.");
      await loadMemoryV4Data();
    } else {
      deps.showToast("Failed to update memory.");
    }
  } catch (err) {
    deps.showToast("Failed to update memory.");
  }
}

async function refreshMemoryV4Summary() {
  try {
    deps.showToast("Refreshing memory profile...");
    const token = await getIdToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch("/api/memory/summary/refresh", { method: "POST", headers });
    if (res.ok) {
      deps.showToast("Memory profile refreshed.");
      await loadMemoryV4Data();
    }
  } catch (err) {
    deps.showToast("Failed to refresh memory.");
  }
}

async function resetMemoryV4Summary() {
  if (!confirm("Are you sure you want to reset your memory profile to default? (30-day safety log active)")) return;
  try {
    const token = await getIdToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch("/api/memory/summary/reset", { method: "POST", headers });
    if (res.ok) {
      deps.showToast("Memory profile reset.");
      await loadMemoryV4Data();
    }
  } catch (err) {
    deps.showToast("Failed to reset memory.");
  }
}

async function deleteAllMemoriesV4() {
  if (!confirm("Are you sure you want to delete all stored memories and turn memory off? (30-day safety log active)")) return;
  try {
    const token = await getIdToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    await fetch("/api/memory/all", { method: "DELETE", headers });
    deps.showToast("All memories deleted and memory turned off.");
    await loadMemoryV4Data();
  } catch (err) {
    deps.showToast("Failed to delete memories.");
  }
}

window.deleteMemoryV4Node = async function(nodeId) {
  try {
    const token = await getIdToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    await fetch(`/api/memory/nodes/${encodeURIComponent(nodeId)}`, { method: "DELETE", headers });
    deps.showToast("Memory item deleted.");
    await loadMemoryV4Data();
  } catch (err) {
    deps.showToast("Failed to delete memory item.");
  }
};

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

// ═══════════════════════════════════════════════════════════════
// Gender (profile setting — stored separately from app settings)
// ═══════════════════════════════════════════════════════════════

let _genderValue = "";

export function setGenderValue(value) {
  _genderValue = value || "";
}

export function getGenderValue() {
  return _genderValue;
}

async function _handleGenderUpdate(gender) {
  _genderValue = gender || "";

  // Save to localStorage for instant load on refresh
  saveGenderToLocal(_genderValue);

  // Re-render just the gender dropdown
  const choiceWrapper = document.querySelector('[data-settings-choice="gender"]');
  if (choiceWrapper) {
    const config = SETTINGS_SELECTS.Gender;
    const effectiveSettings = { ...getAppSettings(), gender: _genderValue };
    const newChoice = createSettingsSelect("Gender", config, effectiveSettings);
    choiceWrapper.replaceWith(newChoice);
    deps.refreshIcons(newChoice);
  }

  // Sync to cloud
  try {
    const token = await getIdToken();
    if (token) {
      await updateUserProfilePreferences({ gender: gender || null }, token);
    }
  } catch (e) {
    console.warn("Failed to sync gender:", e);
  }

  deps.showToast(gender ? `Gender set to ${gender}.` : "Gender cleared.");
}
