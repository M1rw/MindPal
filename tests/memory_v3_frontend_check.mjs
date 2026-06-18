import assert from "node:assert/strict";

import {
  classifyAndStoreMemoryGraphFromMessage,
  createEmptyMemoryGraph,
  getMemoryInspectorCards,
  mergeMemoryGraphs,
} from "../frontend/js/memory_graph.js";

const first = classifyAndStoreMemoryGraphFromMessage(
  "remember: avoid apologetic responses",
  { graphContext: createEmptyMemoryGraph() },
);
const second = classifyAndStoreMemoryGraphFromMessage(
  "remember: avoid emotional responses",
  { graphContext: first.graph },
);

const cards = getMemoryInspectorCards(second.graph);
const avoidCard = cards.find((card) => card.key === "avoid");

assert.ok(avoidCard);
assert.equal(avoidCard.items.length, 2);
assert.deepEqual(
  avoidCard.items.map((item) => item.rawValue).sort(),
  ["apologetic responses", "emotional responses"],
);

const merged = mergeMemoryGraphs(first.graph, second.delta);
const mergedAvoid = getMemoryInspectorCards(merged).find((card) => card.key === "avoid");

assert.ok(mergedAvoid);
assert.equal(mergedAvoid.items.length, 2);
