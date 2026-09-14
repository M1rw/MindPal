# Frontend Quality Harness

The Tier-1 browser harness is `tests/frontend_quality_harness.mjs`.

## Run

```powershell
npm run test:frontend:quality
```

The harness starts the built static frontend on port `4174`, mocks API responses at the network boundary, and runs a deterministic interaction pass.

## What it records

- Every discovered visible interactive control and its accessible name.
- Click, input, change, keydown, and submit events captured during the run.
- API requests observed by the page.
- Browser console errors and uncaught page errors.
- Actions attempted and actions skipped because they are destructive.
- Explicit coverage gaps when an interactive control has no accessible name.

The report is written to `artifacts/frontend-quality/latest.json` and is ignored by Git.

## Safety boundary

The harness does not delete data, forget memory, sign out, reload the application, or end a voice session. Those actions are recorded as destructive candidates and require a separate approved scenario with isolated fixtures.

This is an interaction-quality harness, not a proof that every possible user behavior is finite or covered. New product surfaces should add a named scenario and keep the report free of uncaught errors and unnamed controls.
