# Contracts

This directory is the **source of truth** for the MindPal HTTP product.

- `openapi.yaml` — every route that may exist in FastAPI
- `changelog.json` — user-visible releases; served verbatim at `GET /api/release/changelog`
- `errors.yaml` — stable error codes

Change a URL here first, then implement. CI will reject code that does not match.

See `docs/architecture/backend-platform.md`.
