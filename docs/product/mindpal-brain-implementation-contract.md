# MindPal Obsidian Brain: Implementation Contract

**Status:** Approved implementation specification  
**Scope:** A production-ready Brain workspace built on Memory V3 without replacing its current memory, chat, safety, guest-mode, or cloud-sync contracts.

## Product contract

The MindPal Brain is a user-controlled graph workspace, not a generic note application and not a clinical inference engine. It projects existing durable Memory V3 atoms into inspectable nodes, adds typed links, review records, minimal evidence excerpts, a bounded context pack, and a fast navigator. It must never turn raw chat history into a graph by default, create diagnosis nodes, expose safety-restricted material in the Map, or bypass the existing safety policy.

| Capability | Implemented behavior | Non-negotiable control |
|---|---|---|
| Graph nodes | Existing Memory V3 atoms become stable Brain nodes using their atom ID, category, sensitivity, confidence, source, pin state, and timestamps. | A tombstoned or archived atom is excluded from default maps, search, and response context. |
| Typed links | User-created or deterministic low-risk links connect atom IDs with a relation type, confidence, source, status, and timestamps. | A link is never rendered or used without a type and stable endpoint IDs. |
| Evidence | Minimal excerpts are attached only to a Brain node or link; no complete raw chat duplication is stored. | High-sensitivity evidence is hidden from global map and requires an explicit Focus action. |
| Review | New, stale, conflicting, and expiring records surface in a review queue. | Rejection or removal updates the relevant atom/link state; user control wins over automatic inference. |
| Search and Focus | Fast lexical/entity search, backlinks, category filters, and bounded local graph traversal. | Search results respect sensitivity, status, and hidden-from-replies state. |
| Context planner | A deterministic, explainable selection of at most 6 nodes, 2 evidence items, and 8 graph edges. | High-sensitivity or safety-context material is excluded unless the policy tier explicitly permits it. |

## Additive storage model

The primary Memory V3 document remains the single sync record. A new `brain` envelope is added to `MemoryGraph`; Brain nodes are projected from existing atoms rather than duplicated. This retains current atom merge, pinning, tombstone, and version semantics while storing only Brain-specific records.

```json
{
  "user_id_hash": "hashed-user",
  "atoms": ["existing MemoryAtom records"],
  "version": 42,
  "brain": {
    "schema_version": 1,
    "edges": [],
    "evidence": [],
    "review_queue": [],
    "collections": [],
    "updated_at": "2026-08-13T00:00:00Z"
  }
}
```

| Brain record | Bound | Purpose |
|---|---:|---|
| Edge | 1,000 per graph | Typed relationship between two atom IDs. |
| Evidence | 500 per graph | Short source excerpt plus immutable source metadata. |
| Review record | 500 per graph | Review, stale, conflict, expiry, or correction work item. |
| Collection | 100 per graph | User-created saved filter/view definition. |
| Context pack | 6 nodes, 2 evidence excerpts, 8 links | Fixed prompt and response-latency budget. |

## Secure API contract

All Brain routes use the existing authenticated request context and Memory V3 repository. They do not introduce a separate user data store.

| Endpoint | Purpose |
|---|---|
| `GET /api/brain/overview` | Today data, visible node counts, review counts, and graph metrics. |
| `GET /api/brain/map` | Filtered global or local map with graph depth capped at two. |
| `GET /api/brain/nodes/{atom_id}` | Focus node, properties, evidence, links, and backlinks. |
| `GET /api/brain/search?q=` | Policy-filtered lexical and alias search. |
| `POST /api/brain/edges` | Create a user-controlled typed link. |
| `PATCH /api/brain/edges/{edge_id}` | Confirm, alter, hide, or remove a link. |
| `DELETE /api/brain/edges/{edge_id}` | Remove a link without deleting its nodes. |
| `POST /api/brain/review/{id}` | Confirm, dismiss, pin, or defer a review record. |
| `POST /api/brain/context-plan` | Return the bounded context pack and reasons for an internal/debug request. |

## Context planner

The planner is deterministic and cacheable. It first applies safety and visibility policy, then scores a compact candidate set with lexical match, aliases, recency, confidence, evidence, user pinning, and local graph proximity. It diversifies category selection before creating the final pack.

```text
candidate score =
  0.34 × lexical match
+ 0.20 × atom relevance and recency
+ 0.18 × alias/entity match
+ 0.14 × pinned or explicit source
+ 0.08 × evidence support
+ 0.06 × visible graph proximity
− redundancy and stale penalties
```

The planner is deliberately not an LLM call. This keeps it fast, testable, and safe. The user-facing response pipeline receives concise node text and optional evidence excerpts, never raw hidden prompt material or safety-classification internals.

## Workspace contract: “2090” but usable

The Brain opens as a dedicated in-app workspace from the primary navigation. Its visual language is a high-contrast midnight observatory: cobalt and violet energy gradients, thin orbital arcs, translucent glass panels, luminous graph nodes, and motion that honors reduced-motion preferences. The aesthetic supports clarity rather than decoration.

| Workspace area | Function | Visual behavior |
|---|---|---|
| Command rail | Today, Map, Focus, Review, search, and filters. | Compact holographic tabs with a clear active state. |
| Neural map | Interactive SVG graph with pan, zoom, local/global scope, and category clustering. | Neon node halos encode type; dashed links are tentative; amber indicates review/conflict. |
| Signal inspector | Selected-node details, properties, evidence, backlinks, and actions. | Glass panel with readable text, no hidden information, and keyboard-accessible controls. |
| Context telemetry | Shows graph version, visible nodes, planner budget, and latency. | A small transparent status strip; no personal content in operational metrics. |
| Accessible alternate | A linked list/table equivalent for the graph. | Available in every view and used automatically on reduced-motion or narrow layouts. |

## Integration and compatibility rules

The standard chat path remains functional if the Brain envelope is absent, invalid, or empty. Brain context augments the current durable memory prompt rather than replacing identity-tier memory. A Brain persistence failure must never block a text or voice response; the request degrades to the existing Memory V3 behavior and exposes a recoverable audit signal.

## Acceptance criteria

| Area | Requirement |
|---|---|
| Correctness | Existing Memory V3 tests remain passing; edges only target existing atom IDs; graph version changes only when persisted Brain data changes. |
| Safety | Safety-context and hidden nodes do not appear in normal map/search/context responses; tests cover both behavior and failure envelopes. |
| Performance | A 300-atom deterministic fixture returns a context plan in under 25 ms p95 locally and a local map in under 35 ms p95. |
| UX | The workspace opens without blocking Chat; keyboard controls, reduced-motion behavior, and list alternative exist. |
| Sync | Legacy Memory V3 graphs load with an empty Brain envelope; existing memory writes retain Brain records. |
| Verification | API, service, frontend, browser-state, build, prebuilt manifest, static-analysis, and dependency checks pass. |
