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


test("memory sync persists Brain-only links when atoms are unchanged", async () => {
  const remote = {
    ...graphWith("remember: my project is MindPal"),
    user_id_hash: "user-a",
    version: 9,
  };
  const [source, target] = remote.atoms.length >= 2
    ? remote.atoms
    : [remote.atoms[0], { ...remote.atoms[0], id: "mem_related", category: "goals", value: "Ship MindPal", display_value: "Ship MindPal" }];
  const local = {
    ...remote,
    brain: {
      ...remote.brain,
      edges: [{
        id: "edge_project_goal",
        source_atom_id: source.id,
        target_atom_id: target.id,
        relation: "part_of",
        confidence: 0.9,
        status: "active",
        source: "manual",
        evidence_ids: [],
        created_at: "2026-08-13T00:00:00Z",
        updated_at: "2026-08-13T00:00:00Z",
        last_confirmed_at: "2026-08-13T00:00:00Z",
      }],
    },
  };
  let saved = null;

  const result = await syncMemoryGraphSnapshot(local, {
    initialRemote: remote,
    loadRemote: async () => ({ loaded: true, graph: remote }),
    saveRemote: async (graph, expectedVersion) => {
      saved = { graph, expectedVersion };
      return { saved: true, version: 10 };
    },
  });

  assert.equal(memoryGraphAtomsEqual(remote, local), true);
  assert.ok(saved);
  assert.equal(saved.expectedVersion, 9);
  assert.equal(saved.graph.brain.edges.length, 1);
  assert.equal(saved.graph.brain.edges[0].relation, "part_of");
  assert.equal(result.version, 10);
});
