# Telemetry & Benchmark Audit

## Executive Summary & Findings

An audit of the client observability, telemetry, and benchmark harness scripts (`frontend/js/observability/`, `scripts/audit/benchmark_frontend.mjs`) was performed to identify fake metrics, broken analytics endpoints, and event capture bugs.

---

## Confirmed Telemetry & Observability Bugs

### 1. Fake Memory Benchmark Metrics (`performance.memory`)
- **File**: `scripts/audit/benchmark_frontend.mjs:177` & `frontend/js/observability/neural_observatory.js`
- **Issue**: Non-Chromium browsers or sandboxed headless test environments do not expose `window.performance.memory`. In these environments, fallback code or mock harnesses inject static/fake values (e.g., hardcoded `10 * 1024 * 1024` / `10 MB` heap size).
- **Impact**: Synthetic benchmark metrics mask real browser memory leaks and DOM node bloat during continuous chat sessions.

### 2. Vercel Analytics Script 404s
- **File**: `frontend/index.html` & `frontend/index.template.html`
- **Issue**: Standard Vercel analytics scripts (`/_vercel/insights/script.js` or `https://*.vercel-insights.com`) return HTTP 404 when executed locally or in custom self-hosted Vercel environments where Vercel Web Analytics is disabled in project settings.
- **Impact**: Generates console errors and failed network request noise on every page load.

### 3. Missing Network Request Status Capture
- **File**: `frontend/js/observability/neural_telemetry.js:71` & `frontend/js/observability/safe_mode.js`
- **Issue**: `NeuralTelemetry` events record stage names and timestamps but fail to extract actual HTTP status codes (`response.status`, e.g. 200, 400, 500) from failed or network-error `fetch` responses.
- **Impact**: All network failures appear generically as status `"failed"` without distinction between 401 Unauthorized, 429 Rate Limit, or 500 Internal Error.
