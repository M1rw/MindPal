# Archived Legacy Frontend — 2026-09-13

**Archived by:** React Migration (v5.0.0)
**Superseded by:** `frontend/src/` — React 19 + TypeScript + Zustand

## What This Contains

### `js/`
The full legacy vanilla JavaScript frontend:
- `js/app.js` — stable entrypoint, re-exports from `js/app/main.js`
- `js/app/main.js` (1957 lines) — main bootstrap, event bindings, chat pipeline
- `js/app/brain_page.js` — brain workspace page
- `js/bootstrap.js` — pre-app viewport/analytics bootstrap (kept active in index.html)
- `js/services/` — API, Auth (Firebase), Cloud Sync, Feature Flags clients
- `js/state/` — UI state, settings store, feature store, app state model
- `js/features/` — Memory graph, Voice controller (Layer 6)
- `js/ui/components/` — Memory inspector, Settings UI, Model selector, Usage tracker, Notifications, Feature admin/status panels
- `js/utils/` — DOM helpers, markdown formatter, TTS, chat helpers
- `js/observability/` — Neural telemetry
- `js/vendor/` — Lucide global bundle source

### `components/`
The legacy HTML component templates (included in the pre-compiled index.html):
- `components/header.html` — floating transparent header
- `components/loader.html` — global loading skeleton with typewriter
- `components/toast.html` — toast notification container
- `components/chat/composer.html` — Gemini-style pill composer with model+mode selector
- `components/chat/history.html` — chat messages container
- `components/chat/welcome.html` — gradient greeting + mood buttons
- `components/modals/auth_modal.html` — Firebase auth (Google/Apple/Phone/Email)
- `components/modals/profile_modal.html` — Full 9-tab settings modal (345 lines)
- `components/modals/streak_modal.html` — Streak/journey progress modal
- `components/modals/changelog_modal.html` — Feature changelog
- `components/voice/voice_overlay.html` — Immersive voice call overlay with canvas face

## Why Archived

The legacy frontend was a vanilla JS SPA built directly on top of the HTML template
system. It was functional but carried:
- No TypeScript
- No component isolation (all UI state in a monolithic `ui_state.js`)
- No build-time type checking
- Tight coupling between DOM manipulation and business logic

The React 19 + Zustand + TypeScript replacement provides strict typing, component
isolation, concurrent rendering, and full design parity with the legacy Gemini-inspired
design system.

## Reference Architecture Mapping

| Legacy | React Equivalent |
|---|---|
| `js/services/api.js` | `src/services/api.ts` |
| `js/services/auth.js` | `src/services/auth.ts` |
| `js/services/cloud_sync.js` | `src/services/api.ts` (session endpoints) |
| `js/state/ui_state.js` | `src/store/index.ts` (Zustand) |
| `js/state/settings_store.js` | `src/store/index.ts` (useSettingsStore) |
| `components/header.html` | `src/components/ui/Header.tsx` |
| `components/loader.html` | `src/components/ui/GlobalLoader.tsx` |
| `components/chat/welcome.html` | `src/components/chat/WelcomeScreen.tsx` |
| `components/chat/composer.html` | `src/components/chat/ChatInput.tsx` |
| `components/modals/auth_modal.html` | `src/components/auth/AuthModal.tsx` |
| `components/modals/profile_modal.html` | `src/components/settings/SettingsModal.tsx` |
| `components/modals/streak_modal.html` | `src/components/streak/StreakModal.tsx` |
| `components/voice/voice_overlay.html` | `src/components/voice/VoiceOverlay.tsx` |
