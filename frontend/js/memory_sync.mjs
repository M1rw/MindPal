import {
  memoryGraphFromBackend,
  memoryGraphToBackend,
  mergeMemoryGraphs,
  normalizeMemoryGraph,
} from "./memory_graph.js";

const DEFAULT_MAX_ATTEMPTS = 3;

export function memoryGraphAtomsEqual(left, right) {
  const leftAtoms = memoryGraphToBackend(normalizeMemoryGraph(left)).atoms;
  const rightAtoms = memoryGraphToBackend(normalizeMemoryGraph(right)).atoms;
  return JSON.stringify(leftAtoms) === JSON.stringify(rightAtoms);
}

function graphFromLoadResult(result) {
  const payload = result?.graph || result;
  return payload && typeof payload === "object" ? memoryGraphFromBackend(payload) : null;
}

function isVersionConflict(error) {
  return error?.status === 409 || error?.code === "memory_version_conflict";
}

export async function syncMemoryGraphSnapshot(localGraph, {
  loadRemote,
  saveRemote,
  initialRemote = null,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
} = {}) {
  if (typeof loadRemote !== "function" || typeof saveRemote !== "function") {
    throw new TypeError("Memory sync requires loadRemote and saveRemote functions");
  }

  const desired = normalizeMemoryGraph(localGraph);
  let remote = graphFromLoadResult(initialRemote);
  const attempts = Math.max(1, Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (!remote) {
      remote = graphFromLoadResult(await loadRemote());
      if (!remote) throw new Error("Cloud memory response did not include a graph");
    }

    if (memoryGraphAtomsEqual(remote, desired)) {
      return remote;
    }

    const canonical = mergeMemoryGraphs(remote, desired);
    if (memoryGraphAtomsEqual(remote, canonical)) {
      return normalizeMemoryGraph({
        ...canonical,
        version: remote.version,
        user_id_hash: remote.user_id_hash,
        created_at: remote.created_at,
        updated_at: remote.updated_at,
      });
    }

    try {
      const result = await saveRemote(memoryGraphToBackend(canonical), remote.version);
      return normalizeMemoryGraph({
        ...canonical,
        version: Math.max(1, Number(result?.version || remote.version + 1)),
        user_id_hash: remote.user_id_hash,
      });
    } catch (error) {
      if (!isVersionConflict(error) || attempt === attempts) throw error;
      remote = null;
    }
  }

  throw new Error("Cloud memory sync exhausted its retry budget");
}
