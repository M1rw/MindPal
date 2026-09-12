# MindPal Frontend JavaScript

This directory is organized by responsibility. The root contains only stable browser entrypoints and shared utilities; feature, service, state, UI, and observability code lives in dedicated folders.

## Entry points

- `app.js` is the stable application bundle entrypoint. It delegates to `app/main.js`.
- `brain_page.js` is the stable brain-page bundle entrypoint. It delegates to `app/brain_page.js`.
- `bootstrap.js` is the pre-app loader, viewport, and analytics bootstrap loaded by the HTML shell.

## Folders

| Folder | Responsibility |
| --- | --- |
| `app/` | Page orchestration and page-specific entry modules. |
| `services/` | External service boundaries, including REST API, Firebase authentication, and cloud synchronization. |
| `state/` | Local application state and settings persistence. |
| `features/memory/` | Memory graph domain model, normalization, merging, and cloud graph synchronization. |
| `ui/components/` | Focused UI components for settings, memory, model selection, notifications, usage, and the brain workspace. |
| `utils/` | Small reusable presentation, formatting, date, clipboard, TTS, and memory helper functions. |
| `observability/` | Safe-mode and neural telemetry/observatory modules. |
| `vendor/` | Third-party or build-specific browser adapters. |

## Dependency direction

Page orchestration may depend on services, state, features, UI components, observability, and utilities. UI components may depend on focused services/state/features and utilities. Domain modules should not import page orchestration. Utilities should remain small and avoid importing application entrypoints.

## Refactor rules

Keep browser entrypoint paths stable because `package.json` and the HTML shell build these files directly. Preserve public exports while moving a module. Prefer explicit relative imports over path aliases. Do not place generated bundles, test fixtures, microphone data, or Voice V4 runtime code in this directory as part of the general frontend cleanup.

The archived Voice V3 implementation is not part of this active JavaScript tree. The preserved Voice UI shell remains inactive until a separately approved, layered Voice V4 implementation exists and passes its real browser acceptance gates.
