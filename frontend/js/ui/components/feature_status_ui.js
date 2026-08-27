import { getFeatureSnapshotState } from "../../state/feature_store.js";

const LIFECYCLE_LABELS = Object.freeze({
  active: "Available",
  beta: "Beta",
  preview: "Preview",
  maintenance: "Maintenance",
  disabled: "Disabled for now",
  deprecated: "Deprecated",
});

const REASON_LABELS = Object.freeze({
  enabled: "Available for your account.",
  enabled_for_admin: "Available for administrators.",
  requires_authentication: "Sign in to check whether this feature is available.",
  not_in_rollout: "Not included in the current rollout.",
  preview_only: "Limited preview; access is restricted for now.",
  maintenance: "Temporarily unavailable while we work on it.",
  disabled: "This feature is disabled for now.",
  explicit_deny: "Not enabled for this account.",
  channel_not_allowed: "Not available in this channel.",
  locale_not_allowed: "Not available in this language yet.",
  not_started: "This feature is scheduled for a future release.",
  expired: "This release window has ended.",
  prerequisite_disabled: "Waiting for a required capability.",
  unknown_feature: "This feature is not available in the current release.",
});

export function renderFeatureStatusPanel(root = document.getElementById("feature-status-list")) {
  if (!root) return;
  const snapshot = getFeatureSnapshotState();
  const fragment = document.createDocumentFragment();

  for (const [key, feature] of Object.entries(snapshot.features)) {
    if (feature.user_visible === false) continue;
    fragment.appendChild(createFeatureRow(key, feature));
  }

  root.replaceChildren(fragment);
  root.dataset.snapshotStatus = snapshot.status;
  root.dataset.snapshotStale = snapshot.stale ? "true" : "false";
}

function createFeatureRow(key, feature) {
  const row = document.createElement("article");
  row.className = "settings-row settings-row-block feature-status-row";
  row.dataset.featureKey = key;

  const main = document.createElement("span");
  main.className = "settings-row-main";

  const title = document.createElement("span");
  title.className = "settings-row-title";
  title.textContent = feature.title;

  const description = document.createElement("span");
  description.className = "settings-row-copy";
  description.textContent = feature.description;

  const reason = document.createElement("span");
  reason.className = "settings-row-copy feature-status-reason";
  reason.textContent = REASON_LABELS[feature.reason] || "Availability is controlled by the current release policy.";

  main.append(title, description, reason);

  const badge = document.createElement("span");
  badge.className = `feature-status-badge feature-status-badge--${feature.lifecycle}`;
  badge.textContent = feature.enabled ? LIFECYCLE_LABELS[feature.lifecycle] : LIFECYCLE_LABELS[feature.lifecycle] || "Unavailable";
  badge.setAttribute("aria-label", `${feature.title}: ${badge.textContent}`);

  row.append(main, badge);
  return row;
}
