import { getFeatureSnapshot } from "./api.js";
import {
  applyFeatureSnapshot,
  markFeatureSnapshotStale,
  resetFeatureStore,
} from "../state/feature_store.js";

export async function hydrateFeatureSnapshot(token = null) {
  const snapshot = await getFeatureSnapshot(token);
  return applyFeatureSnapshot(snapshot, { authenticated: Boolean(token) });
}

export function clearFeatureSnapshot() {
  resetFeatureStore();
}

export function invalidateFeatureSnapshot() {
  markFeatureSnapshotStale();
}
