# Memory V3

Memory V3 is the primary durable memory architecture.

Core model:

```txt
MemoryGraph
  atoms[]

MemoryAtom
  id
  category
  key
  value
  normalized_value
  display_value
  confidence
  sensitivity
  source
  status
  pinned
  created_at
  updated_at
  last_seen_at
  evidence_count
  aliases
  metadata
```

Categories:

```txt
profile
people
projects
preferences
avoid
patterns
goals
relationship_context
coping_tools
safety_context
facts
```

Source of truth:

```txt
guest user
  frontend localStorage MemoryGraph

signed-in user
  backend memory_graphs collection
  frontend localStorage is cache and offline/guest delta
```

Compatibility:

```txt
MemorySummary still exists.
MemoryGraph is primary.
MemorySummary is generated from MemoryGraph for old prompt/API paths.
Existing /api/memory endpoints continue to work.
```

Backend files:

```txt
backend/models/memory_v3.py
  MemoryAtom
  MemoryGraph
  MemoryGraphPatch
  load/write result models
  MemorySummary adapters

backend/services/memory_graph_service.py
  deterministic merge
  tombstone delete
  archive
  prompt rendering
  conservative text extraction

backend/services/db_service.py
  load_memory_graph
  save_memory_graph
  delete_memory_graph

backend/api/memory_router.py
  GET /api/memory/v3
  PUT /api/memory/v3
  PATCH /api/memory/v3
  DELETE /api/memory/v3/items/{atom_id}
  POST /api/memory/v3/merge
  POST /api/memory/v3/migrate
```

Chat flow:

```txt
1. If authenticated and memory is allowed, load MemoryGraph.
2. If no graph exists, migrate MemorySummary to MemoryGraph.
3. Build concise grouped prompt from active atoms.
4. Generate answer.
5. Extract deterministic graph delta from user text.
6. Run existing compaction for compatibility and additional low-confidence context.
7. Convert compaction result into graph delta.
8. Merge delta into graph.
9. Save MemoryGraph and compatibility MemorySummary.
10. Return:
    memory_graph_delta
    memory_graph_snapshot
    memory_graph_full_snapshot
    memory_summary
```

Merge rules:

```txt
partial deltas never replace the graph
empty incoming fields do not delete existing atoms
same category/key or normalized category/value merges
people merge by alias or relationship when safe
deleted atoms stay as tombstones
non-manual extraction cannot recreate tombstoned atoms
manual atoms start high confidence
repeated evidence increments evidence_count and raises confidence
pinned atoms keep their display text against lower-confidence updates
aliases merge
updated_at/last_seen_at move forward
```

Frontend files:

```txt
frontend/js/memory_engine.js
  createEmptyMemoryGraph
  normalizeMemoryGraph
  mergeMemoryGraphs
  memoryGraphFromBackend
  memoryGraphToBackend
  memoryGraphFromLegacyMemory
  buildMemoryGraphLines
  answerQuestionFromMemoryGraph
  getMemoryInspectorCards

frontend/js/app.js
  uses MemoryGraph as primary inspector state
  merges backend deltas
  replaces only explicit full snapshots
  renders grouped cards and chips
```

Inspector behavior:

```txt
Avoid
  [apologetic responses] [emotional responses]

not:
  AVOID apologetic
  AVOID emotional
```

Deletion:

```txt
delete chip
  -> mark atom status=deleted locally
  -> signed-in users call DELETE /api/memory/v3/items/{atom_id}
  -> backend stores tombstone
  -> old summaries and low-confidence extraction cannot immediately recreate it
```

Tests:

```txt
tests/test_memory_v3.py
tests/memory_v3_frontend_check.mjs
```
