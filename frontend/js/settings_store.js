const SETTINGS_KEY = "mindpal_app_settings_v1";

export const DEFAULT_APP_SETTINGS = Object.freeze({
  appearance: "system",
  contrast: "system",
  accentColor: "blue",
  language: "auto",
  dictationEnabled: true,
  spokenLanguage: "auto",
  voicePreview: "browser",
  notifications: {
    streakReminders: "off",
    responseComplete: "in_app",
    moodCheckIn: "off",
    memoryUpdates: "in_app",
    safetyFollowUp: "in_app",
  },
  personalization: {
    baseTone: "balanced",
    directness: "high",
    egyptianArabic: "auto",
    cognitiveStructure: true,
    fastAnswers: true,
    customInstructions: "Senior technical partner. Max capacity.\nAnswer directly, preserve constraints, and prefer production-ready fixes.",
  },
  memoryEnabled: true,
  improveProduct: false,
  locationEnabled: false,
});

let appSettings = normalizeSettings(loadRawSettings());

export function getAppSettings() {
  return structuredCloneSafe(appSettings);
}

export function setAppSetting(path, value) {
  const next = structuredCloneSafe(appSettings);
  setPath(next, path, value);
  appSettings = normalizeSettings(next);
  saveRawSettings(appSettings);
  applyVisualSettings(appSettings);
  return getAppSettings();
}

export function mergeAppSettings(patch) {
  appSettings = normalizeSettings(deepMerge(structuredCloneSafe(appSettings), patch || {}));
  saveRawSettings(appSettings);
  applyVisualSettings(appSettings);
  return getAppSettings();
}

export function hydrateSettingsFromProfile(profileResponse) {
  const uiSettings = profileResponse?.profile?.preferences?.ui_settings;
  const customInstructions = profileResponse?.profile?.preferences?.custom_instructions;
  const communicationStyle = profileResponse?.profile?.preferences?.communication_style;
  const locale = profileResponse?.profile?.preferences?.locale;

  const patch = {};
  if (uiSettings && typeof uiSettings === "object") {
    Object.assign(patch, uiSettings);
  }
  if (customInstructions) {
    patch.personalization = {
      ...(patch.personalization || {}),
      customInstructions,
    };
  }
  if (communicationStyle) {
    patch.personalization = {
      ...(patch.personalization || {}),
      baseTone: communicationStyle,
    };
  }
  if (locale) {
    patch.language = locale;
  }

  return mergeAppSettings(patch);
}

export function buildProfilePreferencesPatch() {
  const settings = getAppSettings();

  return {
    locale: settings.language,
    communication_style: settings.personalization.baseTone,
    custom_instructions: settings.personalization.customInstructions,
    ui_settings: settings,
  };
}

export function buildChatSettingsMetadata() {
  const settings = getAppSettings();
  return {
    locale: settings.language,
    ui_language: settings.language,
    communication_style: settings.personalization.baseTone,
    directness: settings.personalization.directness,
    egyptian_arabic_style: settings.personalization.egyptianArabic,
    cognitive_structure: settings.personalization.cognitiveStructure,
    fast_answers: settings.personalization.fastAnswers,
    custom_instructions: settings.personalization.customInstructions,
  };
}

export function applyVisualSettings(settings = appSettings) {
  const root = document.documentElement;
  const normalized = normalizeSettings(settings);
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
  const dark = normalized.appearance === "dark" || (normalized.appearance === "system" && prefersDark);

  root.classList.toggle("dark", Boolean(dark));
  root.dataset.accent = normalized.accentColor;
  root.dataset.contrast = normalized.contrast;

  const themeIcon = document.getElementById("theme-icon");
  if (themeIcon) {
    const nextIcon = dark ? "moon" : "sun";
    if (themeIcon.tagName.toLowerCase() === "svg") {
      const i = document.createElement("i");
      i.id = "theme-icon";
      i.className = "w-5 h-5";
      i.setAttribute("data-lucide", nextIcon);
      themeIcon.replaceWith(i);
    } else {
      themeIcon.setAttribute("data-lucide", nextIcon);
    }
  }

  const modalThemeToggle = document.getElementById("modal-theme-toggle");
  if (modalThemeToggle) {
    modalThemeToggle.checked = dark;
  }
}

export async function requestBrowserNotificationsIfNeeded(value) {
  if (value !== "push") return "not_requested";
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";

  return Notification.requestPermission();
}

function loadRawSettings() {
  try {
    const raw = window.localStorage?.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveRawSettings(settings) {
  try {
    window.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Settings still apply for the active page if storage is blocked.
  }
}

function normalizeSettings(value) {
  const merged = deepMerge(structuredCloneSafe(DEFAULT_APP_SETTINGS), value || {});

  merged.appearance = oneOf(merged.appearance, ["system", "light", "dark"], "system");
  merged.contrast = oneOf(merged.contrast, ["system", "standard", "high"], "system");
  merged.accentColor = oneOf(merged.accentColor, ["blue", "orange", "green"], "blue");
  merged.language = oneOf(merged.language, ["auto", "en", "ar-EG"], "auto");
  merged.dictationEnabled = Boolean(merged.dictationEnabled);
  merged.spokenLanguage = oneOf(merged.spokenLanguage, ["auto", "en-US", "ar-EG"], "auto");
  merged.voicePreview = oneOf(merged.voicePreview, ["browser", "off"], "browser");
  merged.memoryEnabled = Boolean(merged.memoryEnabled);
  merged.improveProduct = Boolean(merged.improveProduct);
  merged.locationEnabled = Boolean(merged.locationEnabled);

  for (const key of Object.keys(DEFAULT_APP_SETTINGS.notifications)) {
    merged.notifications[key] = oneOf(merged.notifications[key], ["off", "in_app", "push"], DEFAULT_APP_SETTINGS.notifications[key]);
  }

  merged.personalization.baseTone = oneOf(merged.personalization.baseTone, ["concise", "balanced", "detailed"], "balanced");
  merged.personalization.directness = oneOf(merged.personalization.directness, ["low", "medium", "high"], "high");
  merged.personalization.egyptianArabic = oneOf(merged.personalization.egyptianArabic, ["auto", "always", "off"], "auto");
  merged.personalization.cognitiveStructure = Boolean(merged.personalization.cognitiveStructure);
  merged.personalization.fastAnswers = Boolean(merged.personalization.fastAnswers);
  merged.personalization.customInstructions = String(merged.personalization.customInstructions || "").slice(0, 800);

  return merged;
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function setPath(target, path, value) {
  const parts = String(path).split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    cursor[part] = cursor[part] && typeof cursor[part] === "object" ? cursor[part] : {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
}

function deepMerge(base, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
      base[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      base[key] = value;
    }
  }
  return base;
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}
