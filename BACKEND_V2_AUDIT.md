# MindPal Backend V2 final audit

## Release verdict

All confirmed backend blockers found in the uploaded repository were repaired in this release. The backend now has explicit trust boundaries, atomic billing and storage mutations, bounded provider access, canonical memory, deterministic configuration, protected diagnostics, pooled transports, and reproducible release gates.

No engineering process can prove that arbitrary production software contains zero defects. This release is considered deployable after the environment-specific controls in the deployment guide are completed and real Firebase/provider integration tests pass.

## Fixed critical findings

- unauthenticated or weakly authenticated paid-provider paths;
- exposed permanent Gemini credential path;
- non-atomic quota checks, double charging, free fallback paths, and concurrent over-consumption;
- request retries without payload-safe idempotency;
- process-local-only rate limits for distributed deployment;
- Memory V3/legacy divergence and concurrent lost updates;
- non-transactional chat/profile synchronization;
- arbitrary nested voice metadata persistence;
- provider connection churn;
- unreliable serverless background tasks;
- tool-output instruction injection boundary;
- production wildcard CORS, exposed diagnostics, enabled docs, missing HSTS/trusted hosts;
- oversized bodies and Firestore-bound documents;
- hard-coded browser deployment origin/project assumptions;
- unresolved names in stream/tool routes missed by the old test suite;
- broken root test collection and executable scratch-test discovery.

## Current release gates

- Python compile: pass
- Python tests: 43 passed
- Node tests: 8 passed
- Ruff: 0 findings
- Bandit: 0 findings
- Frontend deterministic audit: pass
- npm production audit: 0 vulnerabilities
- Production frontend build: pass
- Python packages: exactly pinned in `requirements.lock`
- Development/security tools: pinned in `requirements-dev.lock`

`pip-audit` could not query PyPI in the build sandbox because DNS resolution was unavailable. Run the optional online audit in a networked CI environment before promotion.

## Required production validation outside this repository

1. Enable Firebase App Check enforcement for the registered web app and configure a reCAPTCHA Enterprise site key.
2. Deploy restrictive Firestore Security Rules even though the server uses Admin SDK; direct client access must remain denied unless explicitly required.
3. Configure Firestore TTL policies for `rate_limit_buckets.expires_at` and `idempotency_records.expires_at`.
4. Set the `mindpal_admin=true` custom claim only for operational administrators.
5. Restrict provider and Firebase API keys to the intended services, projects, origins, and quotas.
6. Test real Gemini, Firebase Auth/App Check, microphone, TTS, mobile Safari, provider failover, and cold starts.
7. Run load tests for the intended regional concurrency and set budget/usage alerts.
