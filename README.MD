# MindPal

MindPal is an AI-powered mental health support application featuring a production-oriented FastAPI/Firebase backend, canonical Memory Graph V3, and Gemini Live Voice V3 full-duplex conversational audio interface.

## System Architecture

```text
Browser Client
  ├─ Firebase Auth ID token
  ├─ Firebase App Check token
  └─ request ID / idempotency key
          │
          ├─────────────────────────────────────────────┐
          ▼                                             ▼
FastAPI Request Boundary                     Gemini Live API (Voice V3)
  ├─ Security / Host / CORS / Headers             ├─ Ephemeral single-use token via /api/voice/token
  ├─ Authentication & App Check Attestation       ├─ wss://generativelanguage.googleapis.com/...
  ├─ Quota & Rate Limit Enforcement               ├─ BidiGenerateContentConstrained endpoint
  ├─ Bounded Orchestration & Provider Gateway     ├─ Direct full-duplex 16kHz in / 24kHz out audio
  └─ Canonical Memory Graph V3 Persistence        └─ AudioWorklet PCM streaming & caption sync
```

The permanent Gemini API credentials remain strictly server-side. Voice sessions use short-lived single-use ephemeral tokens.

---

## Key Features

- **Voice System V3**: Real-time full-duplex conversational voice powered by Google Gemini Live API (`gemini-2.5-flash-native-audio-preview` and `gemini-3.1-flash-live-preview`). See `docs/voice_v3_root_cause_analysis.md` for full root-cause analysis and design details.
- **Memory Graph V3**: Canonical, deterministic memory graph store for user profile, preferences, relationship context, and coping patterns.
- **FastAPI / Firebase Backend V2**: Rate-limited, idempotency-guaranteed, quota-enforced API infrastructure with Firebase Auth and App Check attestation.
- **Responsive Web UI**: Built with Tailwind CSS and ESBuild for high performance across desktop and mobile devices.

---

## Directory Structure

```text
.
├── api/                   # Vercel serverless entry points
├── backend/               # FastAPI backend (core, api, services, models, tools)
├── data/                  # Clinical frameworks & reference data
├── docs/                  # System documentation & Voice V3 root cause analysis
├── frontend/              # Frontend web application (JS, CSS, HTML, templates)
├── scripts/               # Build, verification, and audit scripts
├── tests/                 # Comprehensive Python and JavaScript test suites
└── voice/                 # Voice TypeScript source and build configurations
```

---

## Local Setup & Development

### Prerequisites
- Python 3.12+
- Node.js 20+

### Setup Instructions

```bash
# Install Python dependencies
pip install -r requirements.txt -r requirements-dev.lock

# Install Node dependencies
npm install

# Build frontend assets
npm run build
```

### Running Locally

```bash
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
```

---

## Verification & Testing

MindPal features full test suites across Python and JavaScript layers:

```bash
# Run Python backend tests
python -m pytest

# Run JavaScript frontend & Voice V3 tests
npm test

# Build all frontend and Voice assets in the workspace
npm run build:vercel

# Verify the generated workspace outputs
python scripts/verify_frontend_build.py
```

---

## Vercel Deployment

Deployment to Vercel runs `npm ci && npm run build:vercel && python scripts/verify_frontend_build.py`. The frontend and Voice distribution files are generated inside the Vercel build workspace and are intentionally not committed to Git. The FastAPI application serves those generated files after the build completes.

Key production configuration requirements:
- Set environment variables based on `.env.example`.
- Enable Firebase App Check enforcement.
- Configure Firestore TTL policies for rate-limiting and idempotency.

For Voice V3 architecture details and diagnostic history, see:
- `docs/voice/production-startup-failure.md`
