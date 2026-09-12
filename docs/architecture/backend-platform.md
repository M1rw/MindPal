# MindPal Backend Platform

**Status:** platform rebuild in progress (pal-1–pal-4)  
**Supersedes:** dual trees `backend/api` + `backend/features`, and `docs/architecture/system-overview.md` for backend layout  
**Archived code:** `archive/backend-legacy-2026-09-10/`

This is the engineering constitution for the backend. If a change violates an invariant below, it does not ship.

---

## Why the old backend failed

Not because FastAPI is wrong. Because **policy lived in the wrong place**:

| Failure | What happened | Rule that stops it |
|---|---|---|
| Two products in one repo | Live routers in `backend/api/routers`; a second incomplete app in `backend/features` | One package, one composition root, CI fails on a second HTTP tree |
| Chat logic copied twice | `POST /chat` and `POST /chat/stream` each owned safety, memory, RAG, quota | One `ChatOrchestrator`; routers only adapt HTTP |
| Contract drift | UI called `/api/feature/changelog`; server mounted `/api/features/changelog` | Routes exist only if they are in `contracts/openapi.yaml` |
| Dead HTTP | Tools, safety classify, TTS, notifications mounted but unused | If it is not in the product surface, it is not a route |
| Fake stream | Full LLM result buffered, then 96-char SSE slices | Stream means tokens (or honest non-stream) |
| Voice lie | Overlay + `/voice/v4/token` while JS stubbed `allowed: false` | Capability in OpenAPI `x-status: live` only when both sides work |
| Legacy zombies | `PUT /memory` → 410 still in the client | No sunset leftovers in the catalog |
| Agent-writable chaos | Session branches and parallel “clean” rewrites | Contract + drift CI is the source of truth, not a markdown dump |

Big-company pattern this copies: **Google AIP / Stripe OpenAPI / AWS smithy** — the interface file is the product. Code implements it. CI proves they match.

---

## Invariants (non-negotiable)

1. **`contracts/` is source of truth.** Python does not invent URLs. If it is not in OpenAPI, it does not exist.
2. **One implementation per use case.** Chat has one orchestrator. Memory has one graph store. Voice token has one service.
3. **HTTP adapters are thin.** Routers parse, auth, call one domain method, map errors. No RAG/safety/quota in router files.
4. **Internal work is not a public API.** Safety classification and tool execution run inside chat/voice, not as client-facing routes unless a product screen needs them.
5. **Visibility is declared per operation.** Humans, the web app, and coding agents read the same catalog. Secrets and admin ops are `x-ai-access: hidden`.
6. **Changelog is a file, served as that file.** `GET /api/release/changelog` returns `contracts/changelog.json`. No second path, no second spelling.
7. **No v2/v3/v4 in URLs** for new work. Version lives in the catalog (`info.version`) and changelog. Breaking change = new operationId + sunset date, not `/memory/v3`.
8. **Archive is read-only.** Do not add features to `archive/backend-legacy-*`. Port a behavior into the new tree or drop it.
9. **Side LLM calls are budgeted.** Default: one generation per user turn. Understanding / snapshot / clinical are flags with explicit cost, off unless needed.
10. **Streaming is real or absent.** Do not buffer-then-chunk and call it SSE.

---

## Source of truth: `contracts/`

Not a homemade router engine. **OpenAPI 3.1** is the industry format (tooling, codegen, AI, humans). MindPal extensions hang off each operation.

```text
contracts/
  openapi.yaml           # every public HTTP operation
  changelog.json         # release notes; identical bytes served by API
  errors.yaml            # stable error codes → HTTP status + client action
  README.md              # how to change a route
```

### Per-route metadata (`x-mindpal`)

Every operation **must** declare:

```yaml
x-mindpal:
  owner: identity          # domain package name
  status: live             # live | preview | sunset | internal
  audience: user           # public | user | admin | system
  ai-access: schema        # hidden | catalog | schema | invoke
  client: web              # web | none | admin
  sunset: null             # ISO date if deprecated
  side-effects: true       # writes quota, memory, or billing
```

**AI access (coding agents and ops assistants):**

| `ai-access` | Agent may | Used for |
|---|---|---|
| `hidden` | Not listed in the filtered catalog | Admin, debug traces, impersonation, raw credentials |
| `catalog` | See method, path, summary only | Discovery without schemas |
| `schema` | See request/response shapes | Implement clients, write tests |
| `invoke` | Call in non-prod with a scoped token | Health, changelog, feature snapshot |

Filtered catalog endpoint (admin/system only): `GET /api/system/route-catalog?ai_access=schema`  
It is generated from OpenAPI at boot. It is **not** a second hand-written JSON of URLs.

**Why not “a JSON file of URLs that the app itself reads as the router”?**  
That rebuilds FastAPI badly. FastAPI (and every mature shop) already routes from a spec. The win is **drift detection**: registered routes == OpenAPI operations, including method, path, and `operationId`. One JSON/YAML file; the framework stays standard.

### Error catalog

`contracts/errors.yaml` owns codes (`trace_not_found`, `quota_exceeded`, `memory_version_conflict`). Routers only raise `AppError(code=...)`. HTTP status is looked up. Clients never parse English `detail` strings.

### Release / changelog

`contracts/changelog.json`:

```json
{
  "product": "mindpal",
  "current_version": "5.0.0",
  "entries": [
    {
      "version": "5.0.0",
      "released_at": "2026-09-10",
      "major": true,
      "title": "Backend platform",
      "summary": "Single contract, single chat pipeline.",
      "highlights": ["OpenAPI is source of truth", "Legacy HTTP tree archived"]
    }
  ]
}
```

- Web changelog modal uses **only** `GET /api/release/changelog`.
- Dismiss: `POST /api/release/changelog/dismiss` `{ "version": "5.0.0" }` stored per user.
- Shipping a user-visible change without a changelog entry fails CI when `x-mindpal.status` is `live` and the diff touches that operation.

---

## Target tree

Small on purpose. No `features/` vs `api/` vs `services/domain` clones.

```text
contracts/                     # source of truth (not Python)
backend/
  main.py                      # app factory, lifespan, middleware — no domain
  http/                        # thin adapters, one module per OpenAPI tag
    health.py
    release.py                 # changelog
    chat.py                    # stream + (optional) non-stream wrapper
    sessions.py                # current cloud chat
    identity.py                # me, profile, export, delete
    memory.py
    brain.py               # REMOVED — Brain HTTP is retired
    voice.py
    flags.py
    system.py                  # route-catalog, ready — admin/system
  domain/                      # one folder = one owner in x-mindpal.owner
    chat/
      orchestrator.py          # THE chat pipeline (sync or stream share this)
      budget.py                # extra LLM calls allowed?
    memory/
    identity/
    voice/
    safety/                    # classify + output guard; not HTTP
    grounding/                 # RAG corpus; not HTTP
    quota/
    release/
  infra/                       # firebase, httpx, cache, llm provider gateway
    llm/
    store/
    auth/
  workers/                     # optional async jobs; same domain functions
  data/                        # yaml corpus, crisis templates (content, not code)
```

### Why this shape

- **`http/`** cannot grow into 600-line files: a lint/CI cap (e.g. 120 lines) plus “no domain imports except the owner package.”
- **`domain/chat/orchestrator.py`** is the only place that sequences safety → memory → RAG → LLM → guard → persist. Stream adapter iterates tokens from that same object.
- **`infra/llm`** is a gateway: one `generate()` / `generate_stream()`. No Gemini types in `http/`.
- **`data/`** holds clinical YAML. Content changes do not require router edits.
- **No `models/` mega-folder and `schemas/` copy.** Pydantic models live next to the domain that owns them. HTTP request/response models are generated from OpenAPI or live in `http/_schemas.py` generated — not hand-forked.

### What we will not port

Drop unless a product screen needs it as HTTP:

- `POST /api/tools/execute` and `/batch` (keep as domain tools inside chat)
- `POST /api/safety/classify` (keep inside orchestrator)
- `POST /api/tts/synthesize` until a client actually plays server audio
- `GET/PUT /api/notifications/settings` until push is real (local settings stay client-side)
- `GET /api/chat/debug/{id}` public IDOR surface — traces are admin/`ai-access: hidden` or gone
- Duplicate `/memory` 410 stubs, `/memory/v3` naming (new path: `/api/memory/graph`)
- Entire `backend/features/*` tree (archive only)
- **Brain HTTP** (`backend/api/routers/brain.py`, `features/brain/*`) — Obsidian-style map/overview/edges/review over the memory graph. Visual workspace, not a second store. Retired: chat uses the memory graph; no `/api/brain/*`.

---

## Chat pipeline (one)

```text
HTTP (auth, quota token, idempotency key)
  → ChatOrchestrator.run(request, stream: bool)
       1. classify safety          (deterministic, no LLM)
       2. maybe crisis template    (return, refund quota)
       3. load memory graph        (if allowed)
       4. retrieve grounding       (bounded)
       5. optional tools           (allowlist, untrusted data fence)
       6. generate                 (ONE llm call by default)
       7. output guard             (block or rewrite)
       8. persist memory delta     (async, failure does not fail the reply)
  → HTTP JSON or SSE token events
```

`stream=true` uses step 6 streaming **through the guard in a safe way** (sentence-buffer or post-generate stream of **already guarded** text — pick one, document it in OpenAPI description, do not fake it).

Idempotency and quota wrap the orchestrator in `http/chat.py`, not inside prompt assembly.

---

## Auth, admin, AI

- User routes: Firebase bearer + App Check as today.
- Admin: existing admin authority; all admin operations `audience: admin`, `ai-access: hidden` unless explicitly catalog.
- Agent catalog: built from OpenAPI, filtered. Never dumps env, never dumps other users’ traces.
- Debug traces: not a user URL. If needed: admin-only, hashed id, 404 for everyone else (no 403 oracle).

---

## Release engineering

| Mechanism | Role |
|---|---|
| `pyproject.toml` version | Python package version = `contracts/changelog.json.current_version` (CI) |
| `contracts/changelog.json` | User-facing notes |
| OpenAPI `info.version` | API contract version (can match product version at v5) |
| Feature flags | Runtime kill switches; not a substitute for removing dead routes |
| GitHub: one `main` | No agent branch piles; feature branches short-lived |

Deploy gate (must all pass):

1. OpenAPI ↔ FastAPI route set (path + method + operationId)
2. Changelog current_version == pyproject version
3. No `x-mindpal.status: live` operation without a frontend `client` of `web` or `admin` **or** an explicit `client: none` with a reason (webhooks)
4. Unit tests for orchestrator; contract tests generated from OpenAPI examples
5. `ruff` + a max file size on `backend/http/*.py`

---

## Mapping from archived code (port, don’t copy-paste routers)

| Keep the behavior | From archive | Into |
|---|---|---|
| Firebase auth / App Check | `services/domain/auth` | `infra/auth` |
| Quota + idempotency | `services/domain/quota` | `domain/quota` |
| Memory graph | `models/memory.py` + repo | `domain/memory` (one model) |
| Safety rules / crisis YAML | `safety/` | `backend/data/safety` + `domain/safety` |
| RAG corpus | `rag/corpus` | `backend/data/grounding` + `domain/grounding` |
| LLM gateway | `services/domain/llm/service.py` | `infra/llm` |
| Output guard | `output_guard_service.py` | `domain/safety/output_guard.py` |
| Voice v4 tokens | `voice_v4` token service | `domain/voice` |
| Chat SSE + sync | **merge** chat.py + chat_stream.py | `domain/chat/orchestrator.py` |
| Feature snapshot | `api/routers/feature.py` | `domain/flags` + `http/flags.py` |
| Changelog | broken URL pair | `contracts/changelog.json` + `http/release.py` |

Do not port: `bootstrap_v2.py` shims, `features/chat/service.py`, dual admin routers, 410 compatibility endpoints.

---

## Frontend implication (next phase)

The web app will bind **only** to `operationId`s in OpenAPI (generated client or a 1:1 `api.js` map). No raw `fetch('/api/feature/...')`. Frontend stack choice is a later document; it must consume this catalog. Prefer one generated client over duplicated fetch helpers.

---

## TODO — implementation order

Work only in this order. Do not start the frontend rewrite until pal-10 is done.

- [x] **pal-1** Freeze: archived tree read-only; stub `backend/main.py` serves health + release changelog from `contracts/`.
- [x] **pal-2** Finish `contracts/openapi.yaml` for the product surface (no Brain). Every op has `x-mindpal`.
- [x] **pal-3** `contracts/errors.yaml` + `AppError` mapper.
- [x] **pal-4** Drift CI: `scripts/check_openapi_drift.py` + `tests/unit/platform/test_contract.py`. Preview ops return catalog `unavailable`.
- [ ] **pal-5** `infra/auth`, `infra/store`, `infra/llm` ported from archive (behavior-preserving, new paths).
- [ ] **pal-6** `domain/safety` + `domain/grounding` + `domain/quota` (no HTTP).
- [ ] **pal-7** `domain/chat/orchestrator.py` — single pipeline; tests from archived chat+stream cases.
- [ ] **pal-8** `http/chat.py` — stream tokens honestly; optional non-stream = same orchestrator, `stream=false`.
- [ ] **pal-9** identity, memory graph, sessions, voice, flags HTTP adapters (not Brain).
- [ ] **pal-10** `GET/POST /api/release/changelog` dismiss against user store. Version aligned with pyproject.
- [ ] **pal-11** Filtered `GET /api/system/route-catalog` (`ai-access: hidden` ops omitted unless admin).
- [ ] **pal-12** Delete unused archived behaviors (HTTP tools/safety/tts/debug/brain) from the new surface. Document in changelog.
- [ ] **pal-13** Frontend bind to OpenAPI (separate design). Drop Brain UI. No second URL spelling.

---

## Explicit non-goals (this backend generation)

- Rewriting the clinical prompt library for style
- Microservices / Kubernetes
- Replacing Firebase
- GraphQL
- A custom JSON “router engine”
- Keeping `/memory/v3` forever for nostalgia
- Brain HTTP or a second graph product
- React/Vue decision (frontend phase)
