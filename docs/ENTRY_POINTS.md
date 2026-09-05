# Entry Points Inventory

## Backend Server Entry

### Development Startup
- **Entry File**: `backend/main.py`
- **Command**: `uv run uvicorn backend.main:app --reload --port 8000`
- **Execution Path**:
  1. `get_settings()` loads environment settings from `.env`.
  2. `configure_logging()` sets up structured JSON logging.
  3. `create_app()` initializes FastAPI with middleware (CORS, GZip, RequestBodyLimit, RequestContext).
  4. `lifespan(app)` context manager executes `build_service_container(settings).start()` to initialize local storage, auth providers, and memory graph containers.
  5. API routes under `/api` and static frontend static routes are mounted.

### Production Startup (Vercel Serverless)
- **Entry File**: `api/index.py` (imports `app` from `backend.main`).
- **Configuration**: `vercel.json` maps `/api/(.*)` to `api/index.py`.
- **Execution Path**:
  1. Vercel serverless environment defaults `ENVIRONMENT="production"`, `DEBUG="false"`.
  2. Vercel invokes `api/index.py` handler which exposes the WSGI/ASGI `app` object.
  3. Lifespan handles lazy container initialization per lambda instance lifecycle.

---

## Frontend Entry

### Development & Source Build
- **Entry File**: `frontend/index.template.html` & `frontend/js/app.js`
- **Build Script**: `npm run build` (`npm run build:html && npm run build:css && npm run build:icons && npm run build:app`)
- **Execution Path**:
  1. `scripts/assemble_html.mjs` reads `frontend/index.template.html` and injects modular HTML partials from `frontend/components/**/*.html` into `frontend/index.html`.
  2. `esbuild` bundles `frontend/js/app.js` -> `frontend/dist/app.bundle.js` (ESM module).
  3. `esbuild` bundles `frontend/js/vendor/lucide_global.js` -> `frontend/dist/lucide.bundle.js` (IIFE browser bundle).
  4. `tailwindcss` compiles `frontend/css/tailwind.input.css` -> `frontend/css/tailwind.generated.css`.
  5. `frontend/js/bootstrap.js` loads runtime settings from `/runtime-config.js` and initializes Firebase Auth and `frontend/js/app/main.js`.

---

## Configuration & Environment Files

- **`.env` / `.env.example`**: Defines API credentials (`GEMINI_API_KEY`, `FIREBASE_CREDENTIALS_JSON`), security settings (`SECRET_KEY`), feature flags, and CORS configurations.
- **`pyproject.toml` / `uv.lock`**: Python dependency lockfiles, package metadata, and pytest configuration.
- **`package.json` / `package-lock.json`**: Node.js scripts and frontend asset bundler dependencies.
- **`vercel.json`**: Vercel deployment routing, header overrides, and serverless runtime configuration.
- **`tailwind.config.cjs`**: Tailwind CSS theme extension, color palette, and content scan paths.

---

## Database Migrations & Seed Scripts

- **DB Migrations**: Located in `supabase/migrations/`:
  - `0001_mindpal_feature_policies.sql`: Row Level Security (RLS) policies.
  - `0002_mindpal_admin_accounts.sql`: Admin privilege structures.
  - `0003_mindpal_admin_identity_bootstrap.sql`: Identity bootstrap definitions.
- **Fixture Generation & Verification**:
  - `scripts/audit/generate_fixtures.py`: Generates test persona JSON files in `data/audit_fixtures/`.
  - `scripts/test_gemini_auth.py` / `scripts/firebase_smoke.py`: Health verification scripts.
