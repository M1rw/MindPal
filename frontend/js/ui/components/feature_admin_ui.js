import { loadAdminFeaturePolicies, patchAdminFeaturePolicy } from "../../services/api.js";

const LIFECYCLES = ["active", "beta", "preview", "maintenance", "disabled", "deprecated"];
const ENABLEMENT_OPTIONS = [
  ["default", "Registry default"],
  ["true", "Enabled"],
  ["false", "Disabled"],
];

const deps = {
  getCurrentCloudProfileContext: () => null,
  getIdToken: async () => null,
  showToast: () => {},
  refreshIcons: () => {},
};

let currentPolicyRevision = 0;
let initialized = false;

export function initFeatureAdminUI(dependencies = {}) {
  Object.assign(deps, dependencies);
  initialized = true;
  return refreshFeatureAdminPanel();
}

export async function refreshFeatureAdminPanel() {
  const tab = document.getElementById("feature-admin-tab");
  const mobileOption = document.querySelector('#settings-mobile-tabs option[value="feature-admin"]');
  const panel = document.querySelector('[data-settings-panel="feature-admin"]');
  const context = deps.getCurrentCloudProfileContext?.();
  const isAdmin = Boolean(context?.authenticated && context?.isAdmin);

  tab?.classList.toggle("hidden", !isAdmin);
  if (mobileOption) {
    mobileOption.hidden = !isAdmin;
    mobileOption.disabled = !isAdmin;
  }
  if (!isAdmin) {
    panel?.setAttribute("hidden", "");
    return null;
  }
  if (!initialized || !panel) return null;

  const root = document.getElementById("feature-admin-list");
  if (!root) return null;
  renderLoading(root);

  try {
    const token = await deps.getIdToken?.();
    if (!token) throw new Error("Authentication token unavailable");
    const response = await loadAdminFeaturePolicies(token);
    currentPolicyRevision = Number.isInteger(response?.policy_revision) ? response.policy_revision : 0;
    renderAdminFeatures(root, response?.features || []);
    return response;
  } catch (error) {
    root.replaceChildren(createMessage("Feature management is unavailable right now."));
    deps.showToast("Could not load feature management.");
    return null;
  }
}

function renderAdminFeatures(root, features) {
  const fragment = document.createDocumentFragment();
  for (const feature of features) {
    fragment.appendChild(createAdminFeatureRow(feature));
  }
  root.replaceChildren(fragment);
  deps.refreshIcons(root);
}

function createAdminFeatureRow(feature) {
  const wrapper = document.createElement("article");
  wrapper.className = "feature-admin-row";
  wrapper.dataset.featureKey = feature.key;

  const header = document.createElement("div");
  header.className = "feature-admin-row__header";
  const heading = document.createElement("div");
  heading.className = "feature-admin-row__heading";
  const title = document.createElement("strong");
  title.textContent = feature.title;
  const key = document.createElement("code");
  key.textContent = feature.key;
  heading.append(title, key);
  const counts = document.createElement("span");
  counts.className = "feature-admin-row__counts";
  counts.textContent = `${feature.allow_user_count || 0} allow · ${feature.deny_user_count || 0} deny`;
  header.append(heading, counts);

  const description = document.createElement("p");
  description.className = "feature-admin-row__description";
  description.textContent = feature.description;

  const controls = document.createElement("div");
  controls.className = "feature-admin-row__controls";
  const lifecycle = createSelect("Lifecycle", LIFECYCLES, feature.lifecycle);
  const enablement = createSelect("Access", ENABLEMENT_OPTIONS, feature.policy_enabled === null ? "default" : String(feature.policy_enabled));
  const rollout = createNumberInput("Rollout %", feature.rollout_percentage);
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "settings-pill-btn";
  saveButton.textContent = "Save";
  saveButton.addEventListener("click", () => saveFeaturePolicy(feature, lifecycle, enablement, rollout, saveButton));
  controls.append(lifecycle.wrapper, enablement.wrapper, rollout.wrapper, saveButton);

  const targeting = document.createElement("details");
  targeting.className = "feature-admin-row__targeting";
  const summary = document.createElement("summary");
  summary.textContent = "Target specific users (optional)";
  const targetCopy = document.createElement("p");
  targetCopy.textContent = "Enter Firebase user IDs, one per line. Saving a list replaces that list; leave untouched to preserve existing assignments.";
  const targetControls = document.createElement("div");
  targetControls.className = "feature-admin-row__target-controls";
  const allow = createTextarea("Allow-list", "One Firebase user ID per line");
  const deny = createTextarea("Deny-list", "One Firebase user ID per line");
  const applyTargets = document.createElement("label");
  applyTargets.className = "feature-admin-row__apply-targets";
  const applyTargetsInput = document.createElement("input");
  applyTargetsInput.type = "checkbox";
  applyTargetsInput.setAttribute("aria-label", "Replace targeted user lists when saving");
  applyTargets.append(applyTargetsInput, document.createTextNode("Replace targeted lists on save"));
  targetControls.append(allow.wrapper, deny.wrapper, applyTargets);
  targeting.append(summary, targetCopy, targetControls);

  wrapper.append(header, description, controls, targeting);
  return wrapper;
}

async function saveFeaturePolicy(feature, lifecycle, enablement, rollout, saveButton) {
  const originalLabel = saveButton.textContent;
  saveButton.disabled = true;
  saveButton.textContent = "Saving…";
  try {
    const token = await deps.getIdToken?.();
    if (!token) throw new Error("Authentication token unavailable");
    const payload = {
      expected_revision: currentPolicyRevision,
      policy: {
        key: feature.key,
        lifecycle: lifecycle.select.value,
        enabled: enablement.select.value === "default" ? null : enablement.select.value === "true",
        rollout_percentage: rollout.input.value === "" ? null : Number(rollout.input.value),
      },
    };
    const targeting = saveButton.closest(".feature-admin-row")?.querySelector(".feature-admin-row__targeting");
    const replaceTargets = targeting?.querySelector('input[type="checkbox"]')?.checked;
    if (replaceTargets) {
      payload.allow_user_ids = splitLines(targeting.querySelector('[data-target-list="allow"]')?.value);
      payload.deny_user_ids = splitLines(targeting.querySelector('[data-target-list="deny"]')?.value);
    }
    const response = await patchAdminFeaturePolicy(feature.key, payload, token);
    currentPolicyRevision = response.policy_revision;
    saveButton.textContent = "Saved";
    deps.showToast(`${feature.title} policy saved.`);
    window.setTimeout(() => { saveButton.textContent = originalLabel; }, 1200);
  } catch (error) {
    deps.showToast(error?.code === "feature_policy_conflict" ? "Feature policy changed. Reload and try again." : "Feature policy could not be saved.");
    saveButton.textContent = originalLabel;
  } finally {
    saveButton.disabled = false;
  }
}

function createSelect(labelText, options, selected) {
  const wrapper = document.createElement("label");
  wrapper.className = "feature-admin-control";
  const label = document.createElement("span");
  label.textContent = labelText;
  const select = document.createElement("select");
  select.className = "settings-admin-select";
  for (const option of options) {
    const [value, text] = Array.isArray(option) ? option : [option, option[0].toUpperCase() + option.slice(1)];
    const item = document.createElement("option");
    item.value = value;
    item.textContent = text;
    item.selected = value === selected;
    select.appendChild(item);
  }
  wrapper.append(label, select);
  return { wrapper, select };
}

function createNumberInput(labelText, value) {
  const wrapper = document.createElement("label");
  wrapper.className = "feature-admin-control";
  const label = document.createElement("span");
  label.textContent = labelText;
  const input = document.createElement("input");
  input.type = "number";
  input.min = "0";
  input.max = "100";
  input.step = "1";
  input.placeholder = "Default";
  input.className = "settings-admin-input";
  input.value = value === null || value === undefined ? "" : String(value);
  wrapper.append(label, input);
  return { wrapper, input };
}

function createTextarea(labelText, placeholder) {
  const wrapper = document.createElement("label");
  wrapper.className = "feature-admin-target";
  const label = document.createElement("span");
  label.textContent = labelText;
  const textarea = document.createElement("textarea");
  textarea.rows = 3;
  textarea.placeholder = placeholder;
  textarea.dataset.targetList = labelText === "Allow-list" ? "allow" : "deny";
  textarea.className = "settings-admin-textarea";
  wrapper.append(label, textarea);
  return { wrapper, textarea };
}

function splitLines(value) {
  return String(value || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function renderLoading(root) {
  root.replaceChildren(createMessage("Loading feature policies…"));
}

function createMessage(text) {
  const message = document.createElement("p");
  message.className = "feature-admin-empty";
  message.textContent = text;
  return message;
}
