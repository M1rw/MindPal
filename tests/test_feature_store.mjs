import assert from "node:assert/strict";
import test from "node:test";

import {
  applyFeatureSnapshot,
  getFeatureSnapshotState,
  getFeatureState,
  isFeatureEnabled,
  markFeatureSnapshotStale,
  resetFeatureStore,
} from "../frontend/js/state/feature_store.js";

test.afterEach(() => {
  resetFeatureStore();
});

test("safe defaults preserve standard chat and enable live voice", () => {
  assert.equal(isFeatureEnabled("chat.standard_model"), true);
  assert.equal(isFeatureEnabled("voice.live_v4"), true);
  assert.equal(getFeatureState("voice.live_v4").lifecycle, "active");
});

test("server snapshot replaces availability while keeping unmentioned registry entries", () => {
  applyFeatureSnapshot({
    registry_version: 3,
    policy_revision: 7,
    features: [
      {
        key: "chat.standard_model",
        title: "Standard chat",
        description: "Available",
        lifecycle: "maintenance",
        enabled: false,
        reason: "maintenance",
        user_visible: true,
        user_toggleable: true,
        safety_critical: false,
        version: 4,
      },
    ],
  }, { authenticated: true });

  assert.equal(isFeatureEnabled("chat.standard_model"), false);
  assert.equal(getFeatureState("chat.standard_model").reason, "maintenance");
  assert.equal(isFeatureEnabled("security.crisis_interception"), true);
  assert.equal(getFeatureSnapshotState().policyRevision, 7);
});

test("malformed snapshot fields are bounded and unknown keys fail closed", () => {
  applyFeatureSnapshot({
    registry_version: "not-a-number",
    policy_revision: -4,
    features: [
      {
        key: "unknown.future",
        title: "<private>",
        lifecycle: "invalid",
        enabled: true,
        user_visible: true,
      },
    ],
  });

  assert.equal(getFeatureSnapshotState().registryVersion, 1);
  assert.equal(getFeatureSnapshotState().policyRevision, 0);
  assert.equal(isFeatureEnabled("unknown.future"), false);
  assert.equal(getFeatureState("unknown.future").user_visible, false);
});

test("reset clears an authenticated snapshot and stale marking is explicit", () => {
  applyFeatureSnapshot({ features: [] }, { authenticated: true });
  assert.equal(getFeatureSnapshotState().status, "ready");

  markFeatureSnapshotStale();
  assert.equal(getFeatureSnapshotState().status, "stale");
  assert.equal(getFeatureSnapshotState().stale, true);

  resetFeatureStore();
  assert.equal(getFeatureSnapshotState().status, "default");
  assert.equal(getFeatureSnapshotState().identityMarker, "anonymous");
});
