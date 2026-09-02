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

export async function checkAndShowChangelogModal(forceShow = false) {
  try {
    const res = await fetch("/api/features/changelog");
    if (!res.ok) return;
    const data = await res.json();
    const currentVer = data.current_version || "4.0.0";
    const dismissedList = data.dismissed_versions || [];

    const majorEntry = (data.entries || []).find((e) => e.major && e.version === currentVer);
    if (!majorEntry && !forceShow) return;

    if (!forceShow && dismissedList.includes(currentVer)) return;

    const modal = document.getElementById("changelog-modal");
    if (!modal) return;

    const titleEl = document.getElementById("changelog-title");
    const summaryEl = document.getElementById("changelog-summary");
    const highlightsEl = document.getElementById("changelog-highlights");

    if (titleEl) titleEl.textContent = majorEntry?.title || "What's New in MindPal";
    if (summaryEl) summaryEl.textContent = majorEntry?.summary || "";
    if (highlightsEl && majorEntry?.highlights) {
      highlightsEl.innerHTML = majorEntry.highlights.map((h) => `
        <div class="flex items-start gap-2">
          <span class="text-teal-400 font-bold mt-0.5">•</span>
          <span>${h}</span>
        </div>
      `).join("");
    }

    modal.classList.remove("opacity-0", "pointer-events-none");
    modal.classList.add("opacity-100");

    const dismissHandler = async () => {
      modal.classList.add("opacity-0", "pointer-events-none");
      modal.classList.remove("opacity-100");
      try {
        await fetch("/api/features/changelog/dismiss", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: currentVer }),
        });
      } catch (e) {
        console.warn("Changelog dismissal save failed", e);
      }
    };

    const dismissBtn = document.getElementById("dismiss-changelog-btn");
    if (dismissBtn) dismissBtn.onclick = dismissHandler;
    const closeBtn = document.getElementById("close-changelog-btn");
    if (closeBtn) closeBtn.onclick = dismissHandler;
  } catch (error) {
    console.warn("Changelog check failed", error);
  }
}

export function openInsightsModal() {
  document.getElementById("insights-modal")?.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "insights-modal";
  backdrop.className = "fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4";

  const content = document.createElement("div");
  content.className = "bg-slate-900 border border-slate-800 w-full max-w-lg rounded-xl p-6 shadow-2xl space-y-4 text-slate-200";

  content.innerHTML = `
    <div class="flex items-center justify-between border-b border-slate-800 pb-3">
      <h3 class="text-base font-medium text-slate-100 flex items-center gap-2">
        <span>Mental Health Insights & Trends</span>
      </h3>
      <button id="insights-close-btn" type="button" class="text-slate-400 hover:text-slate-200 text-sm">✕</button>
    </div>
    <div id="insights-body" class="text-xs space-y-4">
      <p class="text-slate-400">Loading your reflection summary & screening score history...</p>
    </div>
  `;

  backdrop.appendChild(content);
  document.body.appendChild(backdrop);

  backdrop.querySelector("#insights-close-btn")?.addEventListener("click", () => backdrop.remove());
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });

  fetch("/api/features/insights").then((res) => res.json()).then((data) => {
    const bodyEl = content.querySelector("#insights-body");
    if (!bodyEl) return;
    const history = data.screening_history || [];
    bodyEl.innerHTML = `
      <div class="bg-slate-950/70 p-3.5 rounded-lg border border-slate-800 space-y-1">
        <p class="text-xs font-semibold text-teal-400">Personal Reflection Summary</p>
        <p class="text-xs text-slate-300 leading-relaxed">${data.reflection_summary || "Reflections are accumulated gently as you share your feelings with MindPal."}</p>
        <p class="text-[11px] text-slate-400 pt-1">Mood Trend: <span class="text-slate-200">${data.mood_trend || "Stable"}</span></p>
      </div>

      <div class="space-y-2">
        <p class="text-xs font-semibold text-slate-300">Screening Score History (PHQ-9 / GAD-7)</p>
        ${history.length ? history.map((item) => `
          <div class="flex items-center justify-between bg-slate-950/50 p-2.5 rounded-lg border border-slate-800/80">
            <div>
              <span class="text-xs font-medium text-slate-200 uppercase">${item.instrument} Score: ${item.score}</span>
              ${item.notes ? `<p class="text-[11px] text-slate-400">${item.notes}</p>` : ""}
            </div>
            <span class="text-[10px] text-slate-500">${new Date(item.recorded_at).toLocaleDateString()}</span>
          </div>
        `).join("") : '<p class="text-slate-500">No clinical screening scores recorded yet.</p>'}
      </div>
    `;
  }).catch(() => {
    const bodyEl = content.querySelector("#insights-body");
    if (bodyEl) bodyEl.innerHTML = '<p class="text-slate-400">Unable to load insights right now.</p>';
  });
}
