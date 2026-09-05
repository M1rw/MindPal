# Tech Stack & Runtime Confirmation

## Programming Languages & Runtimes
- **Backend Language**: Python 3.12+ (managed via `uv`)
- **Frontend Language**: JavaScript (ES2022 / Native ES Modules)
- **Node.js Runtime**: Node 24.x (npm 10.9.2)

---

## Backend Tech Stack

### Core Framework & Server
- **Web Framework**: FastAPI `>=0.136,<0.137`
- **ASGI Server**: Uvicorn `[standard] >=0.35,<0.36`
- **Data Validation & Settings**: Pydantic v2 (`>=2.12,<3`), `pydantic-settings` (`>=2.14,<3`)
- **HTTP Client**: HTTPX (`>=0.27,<0.29`)

### External Service SDKs
- **AI / LLM Integration**: Google GenAI SDK (`google-genai >=1.56,<2`)
- **Firebase Admin SDK**: `firebase-admin >=7.4,<8`

### Quality & Testing Tooling
- **Test Framework**: `pytest >=9,<10`, `pytest-asyncio >=1.3,<2`
- **Linter & Formatter**: `ruff >=0.15,<1`
- **Security Scanner**: `bandit >=1.9,<2`, `pip-audit >=2.10,<3`

---

## Frontend Tech Stack

### Bundling & UI Libraries
- **HTML Assembler**: Custom Node script (`scripts/assemble_html.mjs`) for partial inclusion
- **JS Bundler**: `esbuild` 0.28.1 (outputs ESM `frontend/dist/app.bundle.js` and IIFE `frontend/dist/lucide.bundle.js`)
- **CSS Framework**: Tailwind CSS 3.4.17
- **Icon Set**: Lucide Icons 0.468.0
- **HTML Sanitizer**: DOMPurify 3.4.11

### Authentication & Client Services
- **Auth Provider**: Firebase Auth v11.6.1 + Google Identity Services (GSI)
- **Client Storage**: Native Browser `localStorage` + Memory Graph state

---

## Data Layer & Infrastructure Target

### Storage Backends
- **Primary Database / Document Store**: Firebase Firestore / Realtime DB (via `firebase-admin` in production; `InMemoryDBProvider` in development/testing)
- **SQL / Relational Schema**: Supabase PostgreSQL (SQL migrations under `supabase/migrations/` for RLS and Admin identity)

### Deployment Architecture
- **Primary Serverless Host**: Vercel Serverless Functions (`api/index.py` exporting FastAPI `app`)
- **Static Asset Delivery**: Vercel Edge / Static Files Server (`frontend/` directory mounted via FastAPI / Vercel routing)
