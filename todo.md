# MindPal Frontend Remaining Backlog

## Current status
- Major architecture cleanup has already been completed across the frontend shell, store layer, services, and most large components.
- Fresh verification is green:
  - `npx tsc --noEmit`
  - `npm test -- --runInBand`
  - `npm run build`
- The remaining work is now more precise: it is mostly backlog-driven product hardening, performance optimization, and consistency cleanup rather than broad architectural rewrites.

## Completed / verified already
- Store split completed across focused modules in `frontend/src/store/`
- `services/api.ts` cleanup completed with organized `frontend/src/services/api/`
- `services/auth`, `services/firebase`, and `services/telemetry` normalized into folder-based modules
- `AuthModal`, `SettingsModal`, `ChatInput`, and related component files reduced in size
- `useChatInputDictation` and `useDictationAudioAnalysis` split cleanly
- `App.tsx`, `AppPanels.tsx`, and `AppModals.tsx` simplified into clearer app-shell composition
- Settings tab content split into focused modules under `frontend/src/components/settings/tabs/` with an explicit folder entrypoint
- Presence presentation components grouped under `frontend/src/components/presence/parts/` with an explicit folder entrypoint
- Chat components organized into explicit `canvas/`, `history/`, and `input/` domains with root component files removed
- Error boundaries added at app/section/modal boundaries
- Focus trap hook added and wired into modal flows
- `aria-live` support added for streaming updates
- `stopGeneration()` uses `AbortController` in the chat store
- Settings persistence implemented in `frontend/src/store/settings.ts`
- Storage keys centralized in `frontend/src/constants/storage.ts`
- `any` types removed from the frontend source

## Remaining Frontend Backlog

### P0 — Must do before calling the frontend Tier-1 ready

#### 1) Product gating / feature honesty for voice and presence
- Goal: do not ship surfaces that look fully functional when they are still placeholder/waitlist-only.
- File targets:
  - `frontend/src/components/voice/VoiceOverlay.tsx`
  - `frontend/src/components/app/AppModals.tsx`
  - `frontend/src/components/app/AppPanels.tsx`
  - `frontend/src/components/presence/PresenceShell.tsx`
  - `frontend/src/store/flags.ts`
  - `frontend/src/store/index.ts`
- Action:
  - Either wire real voice session behavior end-to-end or gate the feature behind a feature flag and hide the UI until enabled.
  - Decide whether `PresenceShell` should be shown by default or only behind a rollout flag.

#### 2) Expand frontend test coverage to match actual runtime risk
- Goal: move the frontend from zero-coverage to real regression protection.
- File targets:
  - `frontend/tests/`
  - `frontend/src/components/chat/ChatInput.tsx`
  - `frontend/src/components/chat/ChatCanvas.tsx`
  - `frontend/src/components/auth/AuthModal.tsx`
  - `frontend/src/components/settings/SettingsModal.tsx`
  - `frontend/src/components/chat/ChatHistoryModal.tsx`
  - `frontend/src/store/chat.ts`
  - `frontend/src/store/history.ts`
  - `frontend/src/store/settings.ts`
- Action:
  - Add component tests for modal rendering, tab switching, and key interactions.
  - Add store tests for chat message dedupe, update-in-place behavior, history loading states, and settings persistence.
  - Add at least one end-to-end happy path for chat send + stream completion.

#### 3) Finish the accessibility hardening pass
- Goal: remove the remaining WCAG and screen-reader gaps that are still easy to miss.
- File targets:
  - `frontend/src/App.tsx`
  - `frontend/src/components/chat/LiveAnnouncer.tsx`
  - `frontend/src/components/chat/ChatCanvas.tsx`
  - `frontend/src/components/auth/AuthModal.tsx`
  - `frontend/src/components/settings/SettingsModal.tsx`
  - `frontend/src/components/chat/ChatHistoryModal.tsx`
  - `frontend/src/components/ui/Header.tsx`
- Action:
  - Add stronger landmark structure (`main`, `nav`, `region`) where needed.
  - Verify `aria-live` behavior on streamed message updates and transient status changes.
  - Audit message action and form controls for accessible labels and contrast.
  - Confirm keyboard ordering for modals and tab panels.

### P1 — High-value optimization and cleanup

#### 4) Add code splitting / lazy loading for non-critical feature panels
- Goal: reduce initial bundle pressure and make the app feel more like a Tier-1 product shell.
- File targets:
  - `frontend/src/App.tsx`
  - `frontend/src/components/app/AppPanels.tsx`
  - `frontend/src/components/app/AppModals.tsx`
  - `frontend/src/components/settings/SettingsModal.tsx`
  - `frontend/src/components/voice/VoiceOverlay.tsx`
  - `frontend/src/components/presence/PresenceShell.tsx`
  - `frontend/src/components/memory/MemoryInspector.tsx`
  - `frontend/src/components/changelog/ChangelogModal.tsx`
- Action:
  - Introduce `React.lazy()` + `Suspense` for heavy modals/panels that are not needed on first paint.
  - Keep the initial app shell lean and defer optional feature surfaces until they are actually opened.

#### 5) Finish wiring and UX for settings / usage / analytics surfaces
- Goal: reduce the number of UI surfaces that look finished but do not yet carry real data.
- File targets:
  - `frontend/src/components/settings/SettingsModal.tsx`
  - `frontend/src/components/settings/SettingsTabContent.tsx`
  - `frontend/src/store/usage.ts`
  - `frontend/src/store/index.ts`
  - `frontend/src/services/api/index.ts`
  - `frontend/src/types/index.ts`
- Action:
  - Confirm whether `UsageSettingsTab` and `AnalyticsSettingsTab` have real data sources.
  - Hook up any missing API calls or remove placeholder surfaces if they are not yet production-ready.
  - Ensure the UI reflects loading, empty, and error states for analytics/usage.

#### 6) Harden the remaining runtime error and retry UX
- Goal: improve reliability when the network or stream layer fails.
- File targets:
  - `frontend/src/components/chat/ChatCanvas.tsx`
  - `frontend/src/services/api/chat.ts`
  - `frontend/src/services/api/index.ts`
  - `frontend/src/store/chat.ts`
  - `frontend/src/components/ui/ErrorBoundary.tsx`
- Action:
  - Review stream failure paths and make retry flows obvious.
  - Ensure persistent failures surface clear user-facing recovery guidance.
  - Continue to verify that app-level boundaries catch unexpected crashes without blank screens.

### P2 — Cleanup / consistency

#### 7) Remove remaining direct raw storage string usage in UI and bootstrap code
- Goal: keep the storage contract fully centralized and easier for agents to reason about.
- File targets:
  - `frontend/src/components/ui/Header.tsx`
  - `frontend/src/components/settings/SettingsTabContent.tsx`
  - `frontend/src/components/auth/AuthModal.tsx`
  - `frontend/src/components/changelog/ChangelogModal.tsx`
  - `frontend/src/components/presence/PresenceShell.tsx`
  - `frontend/src/main.tsx`
  - `frontend/src/hooks/useChangelogBootstrap.ts`
- Action:
  - Replace remaining hardcoded keys with `STORAGE_KEYS` exports from `frontend/src/constants/storage.ts`.
  - Keep the storage contract consistent across UI bootstraps and feature modules.

#### 8) Final product polish on state visibility and empty states
- Goal: ensure the UX communicates status clearly even when data is loading or unavailable.
- File targets:
  - `frontend/src/components/chat/ChatHistoryModal.tsx`
  - `frontend/src/components/chat/ChatCanvas.tsx`
  - `frontend/src/components/memory/MemoryInspector.tsx`
  - `frontend/src/components/settings/SettingsTabContent.tsx`
- Action:
  - Make loading, empty, and failed states explicit in the UI.
  - Remove any stale dead state fields that no longer affect the rendered experience.

## Suggested next execution order
1. P0-1: gate or wire voice + presence
2. P0-2: add frontend test coverage for chat/store/modal flows
3. P0-3: finish the A11y pass
4. P1-4: add lazy loading/code splitting
5. P1-5: finish usage/analytics wiring
6. P1-6: harden retry/error UX
7. P2-7 and P2-8: cleanup and polish

## New todo checklist
- [ ] Gate or wire `VoiceOverlay` behind a feature flag if the real session flow is not ready
- [ ] Decide whether `PresenceShell` remains visible by default or is behind a rollout flag
- [ ] Add frontend component tests for `ChatInput`, `ChatCanvas`, `AuthModal`, `SettingsModal`, and `ChatHistoryModal`
- [ ] Add frontend store tests for chat dedupe, history loading, and settings persistence
- [ ] Add one end-to-end happy-path test for chat send + stream completion
- [ ] Finish accessibility review for landmarks, labels, contrast, and `aria-live` coverage
- [x] Add lazy loading for `SettingsModal`, `VoiceOverlay`, `PresenceShell`, `MemoryInspector`, and `ChangelogModal`
- [ ] Confirm real data wiring for `UsageSettingsTab` and `AnalyticsSettingsTab`
- [ ] Improve failure/retry UX for streaming and cloud history actions
- [ ] Replace remaining raw storage keys in UI/bootstrap files with `STORAGE_KEYS`
- [ ] Finalize visible loading/empty/error state polish in chat/history/memory flows

## Recommended next milestone
- Target the next milestone as: “Frontend cleanup + product gating + test coverage pass”
- After that, the next milestone can be: “Lazy-loading + analytics/usage completion + final A11y polish”
