# Deploying the Hardened MindPal Release

## Required runtime

- Python 3.11+
- Node.js 20+
- npm 10+

## Verify from the extracted release

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\Verify-MindPal.ps1
```

The verification script installs the locked frontend dependencies, rebuilds production assets, runs Python and Node tests, executes the deterministic frontend audit, and runs the npm production dependency audit.

## Apply to the local MindPal repository

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\Apply-Hardened.ps1 -TargetRoot 'E:\Synthos\MindPal'
```

The script:

1. Creates a timestamped code backup beside the target repository.
2. Excludes `.env`, credentials, virtual environments, node modules, logs, and local/runtime data.
3. Copies the hardened source and generated assets.
4. Rebuilds and verifies the target repository.

## Required production environment

Keep all provider secrets server-side. The browser runtime configuration contains only public deployment and Firebase client identifiers.

At minimum configure:

```text
ENVIRONMENT=production
DEBUG=false
ENABLE_DOCS=false
ENABLE_HSTS=true
GEMINI_API_KEY=<server-only>
CORS_ALLOW_ORIGINS=https://your-production-origin.example
TRUSTED_HOSTS=your-production-origin.example
```

Configure Firebase authorized domains, least-privilege Firestore rules, usage quotas, and App Check separately.

## Vercel

`vercel.json` now installs Python dependencies, runs `npm ci`, builds the production frontend, and routes API and frontend requests through the same FastAPI application.

## Post-deploy acceptance tests

- Root HTML loads with no console CSP violations.
- Google sign-in completes and token refresh works.
- Standard and Pro text streams complete, cancel cleanly, and do not duplicate the user prompt.
- Memory creation, edit, pin, delete, reload, sign-out, and cross-device sync remain consistent.
- Voice starts only after microphone permission, receives audio, supports barge-in, reconnects after a transient network drop, and never exposes a permanent provider key.
- Chrome/Edge desktop, Android Chrome, and iOS Safari each complete a 10-minute call without leaked tracks, duplicate playback, or growing CPU usage.
