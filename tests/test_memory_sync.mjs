import test from "node:test";
import assert from "node:assert/strict";

import {
  memoryGraphAtomsEqual,
  syncMemoryGraphSnapshot,
} from "../frontend/js/memory_sync.mjs";
import {
  classifyAndStoreMemoryGraphFromMessage,
  createEmptyMemoryGraph,
} from "../frontend/js/memory_graph.js";

function graphWith(text, graph = createEmptyMemoryGraph()) {
  return classifyAndStoreMemoryGraphFromMessage(text, { graphContext: graph }).graph;
}

test("memory sync uses the loaded cloud version instead of the client merge version", async () => {
  const remote = { ...graphWith("remember: my name is Marwan"), user_id_hash: "user-a", version: 7 };
  const local = graphWith("remember: my project is MindPal", remote);
  const writes = [];

  const result = await syncMemoryGraphSnapshot(local, {
    initialRemote: remote,
    loadRemote: async () => ({ loaded: true, graph: remote }),
    saveRemote: async (graph, expectedVersion) => {
      writes.push({ graph, expectedVersion });
      return { saved: true, version: 8 };
    },
  });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].expectedVersion, 7);
  assert.ok(writes[0].graph.version > writes[0].expectedVersion);
  assert.equal(result.version, 8);
});

test("memory sync skips writes when only graph metadata changed", async () => {
  const remote = { ...graphWith("remember: my name is Marwan"), user_id_hash: "user-a", version: 4 };
  const local = { ...remote, version: 99, updated_at: new Date().toISOString() };
  let writes = 0;

  const result = await syncMemoryGraphSnapshot(local, {
    initialRemote: remote,
    loadRemote: async () => ({ loaded: true, graph: remote }),
    saveRemote: async () => {
      writes += 1;
      return { version: 5 };
    },
  });

  assert.equal(memoryGraphAtomsEqual(remote, local), true);
  assert.equal(writes, 0);
  assert.equal(result.version, 4);
});

test("memory sync reloads and retries a genuine version conflict", async () => {
  const initialRemote = { ...graphWith("remember: my name is Marwan"), user_id_hash: "user-a", version: 2 };
  const latestRemote = { ...graphWith("remember: avoid apologetic responses", initialRemote), version: 3 };
  const local = graphWith("remember: my project is MindPal", initialRemote);
  const expectedVersions = [];
  let loads = 0;

  const result = await syncMemoryGraphSnapshot(local, {
    initialRemote,
    loadRemote: async () => {
      loads += 1;
      return { loaded: true, graph: latestRemote };
    },
    saveRemote: async (_graph, expectedVersion) => {
      expectedVersions.push(expectedVersion);
      if (expectedVersions.length === 1) {
        throw Object.assign(new Error("conflict"), { status: 409, code: "memory_version_conflict" });
      }
      return { saved: true, version: 4 };
    },
  });

  assert.deepEqual(expectedVersions, [2, 3]);
  assert.equal(loads, 1);
  assert.equal(result.version, 4);
  assert.ok(result.atoms.some((atom) => atom.category === "avoid"));
  assert.ok(result.atoms.some((atom) => atom.category === "projects"));
});
