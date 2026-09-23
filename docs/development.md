# Development

## Setup

Python 3.12 and Node.js 24 (npm 10).

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements-dev.lock   # Windows; use .venv/bin/python elsewhere
npm ci
npm run build          # brand files, Tailwind CSS, app bundle
```

Copy `.env.example` to `.env.local` and fill in what you need. For purely local
work without cloud services:

```bash
ENVIRONMENT=development MINDPAL_STORAGE_PROVIDER=memory ENABLE_FIREBASE=false \
  .venv/Scripts/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8765 --reload
```

In `development` and `test`, bearer tokens starting with `dev_` or `test_` sign
you in as a synthetic account; production refuses them.

## Dependencies

`pyproject.toml` is the source. The lockfiles are generated from it:

```bash
uv pip compile pyproject.toml -o requirements.lock --python-version 3.12
uv pip compile pyproject.toml --extra dev -c requirements.lock --universal -o requirements-dev.lock --python-version 3.12
```

`requirements.txt` only points Vercel at `requirements.lock`.

## Repository layout

```
backend/        FastAPI app: http/ (routes), domain/, infra/, configs/, core/, models/
frontend/       React app (src/), CSS, static assets; built into frontend/dist/
contracts/      openapi.yaml: every route and its operationId
supabase/       Postgres migrations for the document store
scripts/        build/ (used by the build), ci/ (checks), ops/ (operator tools), eval/
tests/          backend/<area>/, frontend/ (node --test), fixtures/
docs/           this documentation; decisions/ holds architecture decision records
```

## Tests

```bash
.venv/Scripts/python -m pytest          # backend: tests/backend
npm test                                # frontend and voice: tests/frontend
```

The frontend suite includes Playwright tests (end-to-end chat, iOS keyboard,
audio worklets). Build the app first, and install the browser once with
`npx playwright install chromium`.

`tests/conftest.py` isolates environment variables and resets the platform
pulse between tests, so load-dependent behavior starts at `calm`. Pin a level in
a test with `monkeypatch.setenv("MINDPAL_PRESSURE_OVERRIDE", "critical")`.

## Evaluating quality

`data/evals/conversations.json` holds English and Arabic cases (venting,
advice, distortions, crisis and benign idioms, memory callbacks, preferences,
trajectory). `python scripts/eval/run_conversation_evals.py` checks them
through the real pipeline with no network; CI runs the same cases. Add
`--judge` for real replies scored by a judge model (needs `GEMINI_API_KEY`;
also the manual "Judged Conversation Evals" workflow), and `--baseline` to fail
on a regression. Production signals (replies, thumbs, positive and negative
reactions, stock sentences dropped) are in the platform pulse's `quality`.

## Checks (CI runs all of these)

| Check | Command |
|---|---|
| Runtime config schemas | `python scripts/ci/validate_runtime_configs.py` |
| Prompt contracts | `python scripts/ci/evaluate_prompt_contracts.py` |
| Supabase migrations | `python scripts/ci/validate_supabase_migrations.py` |
| Layer boundaries, route size, OpenAPI drift | `python scripts/ci/check_architecture.py` |
| Source syntax and integrity | `python scripts/ci/audit_syntax_integrity.py` |
| Frontend security and build output | `python scripts/ci/audit_frontend.py` |
| Docs link to real files | part of the backend test suite |
| Types | `npx tsc --noEmit -p tsconfig.json` |
| Security | `bandit --severity-level medium -r backend`, `pip-audit`, gitleaks |

## Conventions

- Routes stay thin and never import `backend.infra`; put behavior in `backend/domain`.
- Read configuration through `backend.configs`, never `os.environ`.
- Every new route needs an `operationId` in `contracts/openapi.yaml`.
- Record significant decisions as a short file in `docs/decisions/`.
