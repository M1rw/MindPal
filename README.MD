# MindPal Backend V2

MindPal Backend V2 is the production-oriented FastAPI/Firebase backend and bundled web client for MindPal. The release replaces the original check-then-charge, dual-memory, ad-hoc provider architecture with explicit trust, billing, concurrency, storage, and deployment boundaries.

## Architecture

```text
Browser
  ├─ Firebase Auth ID token
  ├─ Firebase App Check token
  └─ request ID / idempotency key
          │
          ▼
FastAPI request boundary
  ├─ body-size / host / CORS / security headers
  ├─ authentication + attestation
  ├─ distributed rate limit + local concurrency bound
  ├─ idempotency claim
  ├─ atomic quota reservation
  ├─ bounded orchestration + pooled provider gateway
  ├─ output guard
  └─ transactional persistence
          ├─ chat/profile store
          └─ canonical Memory Graph V3
```

The permanent Gemini credential remains server-side. Voice sessions use one-use, constrained Live API tokens. Memory Graph V3 is the only writable memory source; legacy summary views are derived compatibility output.

## Local setup

Requirements: Python 3.12+, Node.js 20+.

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.lock
npm ci --no-audit --no-fund
Copy-Item .env.production.example .env
```

Use development-safe values in `.env` for local work. Production startup intentionally fails when Firebase Auth/App Check, explicit hosts/CORS, HSTS, revoked-token verification, or a remote provider is missing.

Run locally:

```powershell
npm run build
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
```

## Release verification

```powershell
.\Verify-Backend-V2.ps1 -ProjectRoot $PWD
```

Network-dependent Python CVE lookup:

```powershell
.\Verify-Backend-V2.ps1 -ProjectRoot $PWD -OnlineAudit
```

The deterministic gate compiles Python, runs Python and Node tests, runs Ruff and Bandit, rebuilds the frontend, audits browser delivery, checks npm production dependencies, validates architecture invariants, creates a fail-closed production `Settings` instance, and resolves OpenAPI routes.

## Safe deployment over an existing repository

```powershell
Expand-Archive .\MindPal_backend_v2_release.zip -DestinationPath .\MindPal_Backend_V2
Set-ExecutionPolicy -Scope Process Bypass
.\MindPal_Backend_V2\MindPal_backend_v2\Apply-Backend-V2.ps1 `
  -TargetRoot 'E:\Synthos\MindPal'
```

The apply script backs up only managed source paths, leaves `.env`, credentials, logs, and runtime data untouched, installs locked dependencies, rebuilds, verifies, and rolls source code back automatically on failure.

## Vercel mixed-runtime deployment

Keep `requirements.txt`, `package.json`, `pyproject.toml`, and `vercel.json` in the configured Vercel Root Directory. Do not set a custom Install Command: Vercel must install Python dependencies from `requirements.txt`, while the regular npm dependency set contains the frontend build tools. The repository Build Command is `npm run build`. See `VERCEL_PYTHON_DEPENDENCY_FIX.md`.

## Production requirements

Complete `.env.production.example`, enable Firebase App Check enforcement, create Firestore TTL policies for rate-limit and idempotency records, deny unintended direct client database access, restrict provider/API keys, assign `mindpal_admin=true` only to operational administrators, and run real provider/device/load tests before traffic promotion.

See:

- `BACKEND_V2_ARCHITECTURE.md`
- `BACKEND_V2_AUDIT.md`
- `BACKEND_V2_CHANGELOG.md`
- `DEPLOY_BACKEND_V2.md`
