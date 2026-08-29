const SAFE_FEATURE_DEFAULTS = Object.freeze({
  "chat.standard_model": { key: "chat.standard_model", title: "Standard chat", description: "Fast, warm peer support for everyday conversations.", lifecycle: "active", enabled: true, reason: "enabled", user_visible: true, user_toggleable: true, safety_critical: false, fallback_key: null, replacement_key: null, version: 1 },
  "chat.pro_model": { key: "chat.pro_model", title: "Pro chat", description: "Deeper reasoning and structured reflection tools.", lifecycle: "active", enabled: false, reason: "requires_authentication", user_visible: true, user_toggleable: true, safety_critical: false, fallback_key: "chat.standard_model", replacement_key: null, version: 1 },
  "chat.listening_styles": { key: "chat.listening_styles", title: "Listening styles", description: "Active Listen, Guided Coach, and Cognitive Tools modes.", lifecycle: "active", enabled: true, reason: "enabled", user_visible: true, user_toggleable: true, safety_critical: false, fallback_key: null, replacement_key: null, version: 1 },
  "memory.local": { key: "memory.local", title: "Local memory", description: "Personal context stored on this device.", lifecycle: "active", enabled: true, reason: "enabled", user_visible: true, user_toggleable: true, safety_critical: false, fallback_key: null, replacement_key: null, version: 1 },
  "memory.cloud_sync": { key: "memory.cloud_sync", title: "Cloud sync", description: "Sync memory and conversations across signed-in devices.", lifecycle: "active", enabled: false, reason: "requires_authentication", user_visible: true, user_toggleable: true, safety_critical: false, fallback_key: "memory.local", replacement_key: null, version: 1 },
  "mental_health.insights": { key: "mental_health.insights", title: "Mental-health insights", description: "Personal reflection summaries and screening history.", lifecycle: "beta", enabled: false, reason: "disabled", user_visible: true, user_toggleable: true, safety_critical: false, fallback_key: "chat.standard_model", replacement_key: null, version: 1 },
  "data.export": { key: "data.export", title: "Conversation export", description: "Download the current local conversation.", lifecycle: "active", enabled: true, reason: "enabled", user_visible: true, user_toggleable: true, safety_critical: false, fallback_key: null, replacement_key: null, version: 1 },
  "data.product_improvement": { key: "data.product_improvement", title: "Product improvement signals", description: "Share anonymized product-quality signals.", lifecycle: "preview", enabled: false, reason: "preview_only", user_visible: true, user_toggleable: true, safety_critical: false, fallback_key: null, replacement_key: null, version: 1 },
  "notifications.response_complete": { key: "notifications.response_complete", title: "Response-complete notifications", description: "Notify you when a reply finishes in the background.", lifecycle: "beta", enabled: true, reason: "enabled", user_visible: true, user_toggleable: true, safety_critical: false, fallback_key: null, replacement_key: null, version: 1 },
  "notifications.streak_reminders": { key: "notifications.streak_reminders", title: "Streak reminders", description: "Gentle reminders when a reflection streak is at risk.", lifecycle: "beta", enabled: false, reason: "disabled", user_visible: true, user_toggleable: true, safety_critical: false, fallback_key: null, replacement_key: null, version: 1 },
  "notifications.mood_check_in": { key: "notifications.mood_check_in", title: "Mood check-ins", description: "An optional evening reflection prompt.", lifecycle: "beta", enabled: false, reason: "disabled", user_visible: true, user_toggleable: true, safety_critical: false, fallback_key: null, replacement_key: null, version: 1 },
  "security.crisis_interception": { key: "security.crisis_interception", title: "Crisis interception", description: "Deterministic local emergency-support handling.", lifecycle: "active", enabled: true, reason: "enabled", user_visible: true, user_toggleable: false, safety_critical: true, fallback_key: null, replacement_key: null, version: 1 },
  "brain.workspace": { key: "brain.workspace", title: "Brain workspace", description: "Explore and manage durable memory context.", lifecycle: "beta", enabled: false, reason: "requires_authentication", user_visible: true, user_toggleable: true, safety_critical: false, fallback_key: "memory.local", replacement_key: null, version: 1 },
  "voice.live_v4": { key: "voice.live_v4", title: "Live voice", description: "Real-time full-duplex voice conversation.", lifecycle: "active", enabled: true, reason: "enabled", user_visible: true, user_toggleable: true, safety_critical: false, fallback_key: "chat.standard_model", replacement_key: null, version: 1 },
});

let currentSnapshot = createDefaultSnapshot();

export function getFeatureState(key) {
  const normalizedKey = normalizeKey(key);
  return cloneFeature(currentSnapshot.features[normalizedKey] || unknownFeature(normalizedKey));
}

export function isFeatureEnabled(key) {
  return Boolean(getFeatureState(key).enabled);
}

export function getFeatureSnapshotState() {
  return {
    registryVersion: currentSnapshot.registryVersion,
    policyRevision: currentSnapshot.policyRevision,
    status: currentSnapshot.status,
    stale: currentSnapshot.stale,
    identityMarker: currentSnapshot.identityMarker,
    features: Object.fromEntries(
      Object.entries(currentSnapshot.features).map(([key, value]) => [key, cloneFeature(value)]),
    ),
  };
}

export function resetFeatureStore() {
  currentSnapshot = createDefaultSnapshot();
}

export function applyFeatureSnapshot(payload, { authenticated = false } = {}) {
  const identityMarker = authenticated ? "authenticated" : "anonymous";
  const features = normalizeFeatureList(payload?.features);
  currentSnapshot = {
    registryVersion: positiveInteger(payload?.registry_version, 1),
    policyRevision: nonNegativeInteger(payload?.policy_revision, 0),
    status: "ready",
    stale: Boolean(payload?.stale),
    identityMarker,
    features,
  };
  return getFeatureSnapshotState();
}

export function markFeatureSnapshotStale() {
  currentSnapshot = { ...currentSnapshot, stale: true, status: "stale" };
}

function normalizeFeatureList(features) {
  const normalized = Object.fromEntries(
    Object.entries(SAFE_FEATURE_DEFAULTS).map(([key, value]) => [key, cloneFeature(value)]),
  );
  if (!Array.isArray(features)) return normalized;

  for (const rawFeature of features) {
    const key = normalizeKey(rawFeature?.key);
    if (!key || !rawFeature || typeof rawFeature !== "object") continue;
    if (!Object.hasOwn(normalized, key)) continue;
    const fallback = normalized[key];
    normalized[key] = {
      ...fallback,
      key,
      title: cleanText(rawFeature.title, fallback.title),
      description: cleanText(rawFeature.description, fallback.description),
      lifecycle: normalizeLifecycle(rawFeature.lifecycle, fallback.lifecycle),
      enabled: Boolean(rawFeature.enabled),
      reason: cleanText(rawFeature.reason, fallback.reason),
      user_visible: rawFeature.user_visible !== false,
      user_toggleable: Boolean(rawFeature.user_toggleable),
      safety_critical: Boolean(rawFeature.safety_critical),
      fallback_key: normalizeNullableKey(rawFeature.fallback_key),
      replacement_key: normalizeNullableKey(rawFeature.replacement_key),
      version: positiveInteger(rawFeature.version, fallback.version),
    };
  }
  return normalized;
}

function createDefaultSnapshot() {
  return {
    registryVersion: 1,
    policyRevision: 0,
    status: "default",
    stale: true,
    identityMarker: "anonymous",
    features: normalizeFeatureList([]),
  };
}

function unknownFeature(key) {
  return {
    title: "Unavailable feature",
    description: "This feature is not available in the current release.",
    lifecycle: "disabled",
    enabled: false,
    reason: "unknown_feature",
    user_visible: false,
    user_toggleable: false,
    safety_critical: false,
    fallback_key: null,
    replacement_key: null,
    version: 1,
    key,
  };
}

function cloneFeature(feature) {
  return { ...feature };
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeNullableKey(value) {
  const key = normalizeKey(value);
  return key || null;
}

function normalizeLifecycle(value, fallback) {
  return ["active", "beta", "preview", "maintenance", "disabled", "deprecated"].includes(value) ? value : fallback;
}

function cleanText(value, fallback) {
  const text = String(value || "").trim().slice(0, 500);
  return text || fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? number : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}
