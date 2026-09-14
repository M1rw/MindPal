# MindPal Brain: Before-and-After Context Benchmark

**Author:** Manus AI  
**Date:** 2026-08-13  
**Status:** Deterministic implementation benchmark

## Purpose and method

This benchmark measures the **context-selection layer**, not model intelligence, therapeutic quality, or user outcomes. It compares the prior broad Memory V3 Tier 2 selection with the implemented MindPal Brain planner on one deterministic 300-atom generic wellness/productivity workload. The query concerns protecting a sleep routine during stressful work deadlines, and the fixture identifies three relevant durable items: a goal, a recurring pattern, and a user-described coping tool. The runner executes 200 local iterations and writes the machine-readable measurements to the benchmark artifact.[1]

> **Interpretation boundary:** The results demonstrate that the Brain planner narrows and diversifies durable context on this controlled workload. They are not a substitute for longitudinal evaluation with consented production data, and they do not claim any clinical outcome or diagnostic capability.

| Measure | Before: broad Memory V3 selection | After: Brain planner | Measured change |
|---|---:|---:|---:|
| Durable nodes supplied | 30 | 5 | **83.33% fewer** |
| Relevant nodes retained | 3 | 3 | **No recall loss** on this fixture |
| Relevance density | 10.0% | 60.0% | **6.0× higher** |
| Prompt-context characters | 1,314 | 617 | **53.04% fewer** |
| Included evidence excerpts | 0 | 1 | Provenance is available |
| Included typed edges | 0 | 2 | Relationship context is available |
| Local cold p50 | 0.640 ms | 18.625 ms | Planner performs richer bounded scoring |
| Local cold p95 | 0.692 ms | 19.074 ms | Within the 25 ms local acceptance target |
| Repeated-query cache | Not applicable | Cache hit | Graph-versioned reuse verified |

## What improved

The previous route selected up to thirty durable Tier 2 memory atoms based primarily on general relevance. It retained all three target items in this fixture, but only three of thirty items were directly useful to the question. The Brain planner kept the same three target items while limiting the final pack to five diversified nodes. Its **60% relevance density** is six times the earlier selection’s 10%, so the response pipeline receives far less incidental personal context while retaining the tested task-relevant signals.[1]

The resulting Brain context is also materially smaller. Its 617 rendered characters are 53.04% below the prior 1,314-character broad memory context. In addition to the selected node text, it can provide one minimal evidence excerpt and two typed relationships. This means the receiving response pipeline can understand *why* a goal, pattern, and coping tool appear together without receiving the entire graph or a duplicated transcript.[1]

| Capability | Before | After |
|---|---|---|
| Query-aware candidate ranking | Broad category/relevance ordering | Lexical, alias/entity, concept/vector signal when available, recency, confidence, pinning, evidence, and graph proximity |
| Context budget | Up to 30 Tier 2 items | At most 6 durable nodes, 2 evidence excerpts, and 8 links |
| Diversity | No per-type cap in selection | A maximum of two items per Brain node type |
| Sensitive visibility | Memory-tier behavior | Policy-gated map/search/context behavior; standard policy hides safety and high-sensitivity nodes |
| Explainability | Prompt rendering only | `why_selected`, evidence links, typed edges, backlinks, Focus inspector, and review workflow |
| Repeat performance | No plan cache | Graph-versioned LRU cache; repeated query cache hit verified |

## Performance interpretation

The raw local planning step is slower than rendering preselected Memory V3 items because it intentionally evaluates a small candidate pool, applies safety/visibility constraints, deduplicates content, diversifies node types, collects supporting evidence, and selects connected edges. Its measured cold p95 is **19.074 ms** for the 300-atom fixture, below the implementation contract’s 25 ms local target. A repeated same-version request uses the planner cache, avoiding the ranking pass.[1]

The benchmark therefore supports the design objective: accept a small bounded local-planning cost to sharply reduce prompt context and irrelevant recall. Model-response latency and provider latency are intentionally excluded; the test isolates the in-process context-planning path so the comparison remains reproducible.

## Verification status

The benchmark accompanies service, API, deletion-propagation, frontend sync, and delivery regressions. The specific cases verify that standard policy hides restricted safety context, local maps retain typed relationships, a deleted atom detaches evidence and tombstones connected links, Brain-only client changes synchronize even when atoms are unchanged, and the delivered app contains an accessible list equivalent with reduced-motion styling.[1]

## References

[1]: ./mindpal-brain-benchmark.json "Deterministic MindPal Brain benchmark artifact"
