// frontend/js/settings_store.js — App settings state, persistence, and visual application

const SETTINGS_KEY = "mindpal_app_settings_v1";

const DEFAULT_APP_SETTINGS = Object.freeze({
  appearance: "system",
  language: "auto",
  dictationEnabled: true,
  notifications: {
    responseComplete: "in_app",
    streakReminders: "off",
    moodCheckIn: "off",
  },
  memoryEnabled: true,
  improveProduct: false,
});

let appSettings = normalizeSettings(loadRawSettings());

// Auto-sync theme icon when OS preference changes while appearance = "system"
try {
  window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener("change", () => {
    if (appSettings.appearance === "system") {
      applyVisualSettings(appSettings);
    }
  });
} catch { /* older browsers */ }

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

function mergeAppSettings(patch) {
  appSettings = normalizeSettings(deepMerge(structuredCloneSafe(appSettings), patch || {}));
  saveRawSettings(appSettings);
  applyVisualSettings(appSettings);
  return getAppSettings();
}

export function hydrateSettingsFromProfile(profileResponse) {
  const uiSettings = profileResponse?.profile?.preferences?.ui_settings;
  const locale = profileResponse?.profile?.preferences?.locale;

  const patch = {};
  if (uiSettings && typeof uiSettings === "object") {
    Object.assign(patch, uiSettings);
  }
  if (locale) {
    patch.language = locale;
  }

  // Strip any stale personalization key from cloud data
  delete patch.personalization;

  return mergeAppSettings(patch);
}

export function buildProfilePreferencesPatch() {
  const settings = getAppSettings();

  return {
    locale: settings.language,
    ui_settings: settings,
  };
}

export function buildChatSettingsMetadata() {
  const settings = getAppSettings();
  return {
    locale: settings.language,
    ui_language: settings.language,
  };
}

export function applyVisualSettings(settings = appSettings) {
  const root = document.documentElement;
  const normalized = normalizeSettings(settings);
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
  const dark = normalized.appearance === "dark" || (normalized.appearance === "system" && prefersDark);

  root.classList.toggle("dark", Boolean(dark));
  // Theme icon handled purely by CSS: moon = block dark:hidden, sun = hidden dark:block
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

  if (!merged.notifications || typeof merged.notifications !== "object") {
    merged.notifications = {};
  }

  for (const key of Object.keys(DEFAULT_APP_SETTINGS.notifications)) {
    merged.notifications[key] = oneOf(merged.notifications[key], ["off", "in_app", "push"], DEFAULT_APP_SETTINGS.notifications[key]);
  }

  // Strip stale personalization key if present from old localStorage data
  delete merged.personalization;

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
