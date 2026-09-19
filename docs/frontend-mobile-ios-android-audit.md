# MindPal Mobile Frontend Audit: iOS and Android

Generated: 2026-09-19

## Scope

This is a code and test-harness audit of the current React frontend in `frontend/src/`. It covers:

- iOS Safari and iOS home-screen standalone mode
- Android Chrome and Android installed PWA standalone mode
- narrow phones, landscape phones, tablets, orientation changes, and virtual keyboards
- touch interaction, accessibility, dialogs, chat composition, voice, authentication, history, settings, memory, and PWA metadata

This document does not claim that real-device behavior has been proven. The existing automated visual audit uses Chromium emulation at `1280x900` and `390x844`; it does not run WebKit or Android Chrome and does not grant microphone permissions.

## Executive Summary

The frontend has a good mobile foundation. It already includes `viewport-fit=cover`, dynamic viewport sizing, safe-area padding, a standalone-mode class, 16px mobile form controls to avoid iOS focus zoom, responsive header actions, a growing composer, focus traps, reduced-motion handling, and a PWA manifest.

The largest remaining risks are validation and interaction fidelity rather than a missing responsive shell:

1. The automated audit does not test WebKit/iOS Safari or Android Chrome.
2. Header icon controls are visually 32-36px, below the recommended 44pt iOS target unless their effective hit area is expanded elsewhere.
3. Keyboard, orientation, standalone mode, notch/home-indicator placement, and dynamic browser chrome are not covered by the current test suite.
4. Voice permission, denied permission, interrupted audio, Bluetooth/headset changes, and iOS audio-session behavior are not covered.
5. The app disables user scaling with `user-scalable=no`, which is a significant accessibility concern on mobile.
6. The PWA manifest is minimal: it lacks screenshots, shortcuts, categories, language, and explicit Android launch/display refinements.
7. The current viewport documentation is stale in places and should not be treated as the implementation contract.

## Current Frontend Structure

### Runtime shell

| Area | Current implementation | Mobile responsibility |
|---|---|---|
| HTML shell | `frontend/index.html` | viewport metadata, PWA metadata, theme color, manifest, stylesheet loading |
| Bootstrap | `frontend/src/main.tsx` | dynamic viewport measurement, orientation/visualViewport listeners, standalone detection, theme initialization |
| App shell | `frontend/src/App.tsx` | full-height flex layout, header, panels, modals, skip link, overflow containment |
| Header | `frontend/src/components/ui/Header.tsx` | tabs, new chat, history, theme, streak, settings, mobile overflow menu |
| Tabs | `frontend/src/components/ui/TabBar.tsx` | Chat/Presence mode switcher and keyboard roving focus |
| Chat | `frontend/src/components/chat/` | transcript, empty state, message actions, editing, streaming, composer |
| Composer | `frontend/src/components/chat/input/` | text input, auto-grow, model selector, dictation, live voice CTA, send/stop |
| Dialogs | `frontend/src/components/ui/Modal.tsx` and feature modals | shared overlay chrome, focus trapping, stacked settings/memory flows |
| Voice | `frontend/src/components/voice/VoiceOverlay.tsx` and `frontend/src/voice/` | consent, connection, captions, live state, mute, crisis handling, recap |
| State | `frontend/src/store/` | Zustand stores for chat, history, auth, settings, voice, memory, streak, flags, session |
| Styling | `frontend/css/style.css`, Tailwind generated CSS, brand tokens | safe areas, viewport height, responsive layout, motion and theme tokens |
| Browser tests | `tests/frontend_quality_harness.mjs`, `tests/frontend_visual_audit.mjs` | mocked API interaction and Chromium visual/semantic checks |

The project documentation identifies the current client as a React 19 SPA bundled with esbuild, styled with Tailwind and brand tokens, with Zustand state and API services under `frontend/src/services/api/`.

## Existing Mobile Strengths

### Viewport and safe areas

- `viewport-fit=cover` allows the layout to use the full display on notched iPhones.
- `interactive-widget=resizes-content` is declared for virtual keyboard resizing.
- `.h-dvh-safe` falls back from `100vh` to `100dvh` to a JS-set `--app-height` value.
- `main.tsx` measures `visualViewport.height` when available and updates on resize, orientation change, visual viewport resize, and visual viewport scroll.
- `pt-safe-top` protects the header from the status-bar/notch region.
- `pb-safe` protects the composer from the home indicator and Android gesture area.
- Voice controls intentionally use a smaller, separate bottom inset rule rather than the general composer spacing.

### iOS input behavior

- Mobile text inputs and textareas are forced to at least 16px, reducing Safari's automatic focus zoom.
- The composer textarea has a 44px minimum height.
- The composer uses `dir="auto"`, which improves mixed-language and right-to-left text entry.
- The composer grows up to a fixed cap and has an explicit expanded mode.
- `-webkit-overflow-scrolling: touch` is used for custom scrollable regions.

### Responsive interaction model

- Desktop-only history/theme/streak actions collapse into a mobile “More actions” menu.
- Presence is feature-flagged and the tab bar disappears when only Chat is available.
- The header and composer are separate from the transcript, reducing the risk of the input being pushed below long responses.
- The shared modal shell avoids each feature inventing different close, radius, and overlay behavior.

### Accessibility foundations

- Main landmarks, navigation landmarks, a chat log, accessible labels, and a skip link are present.
- Dialogs use `role="dialog"`, `aria-modal`, labels, and a shared focus trap.
- Tabs implement `role="tablist"`, `role="tab"`, `aria-selected`, `aria-controls`, and arrow/Home/End navigation.
- Icon buttons generally have `aria-label` and/or `title`.
- Reduced-motion media queries exist in the main stylesheet and voice overlay.

## Findings

Severity uses `P0` for release-blocking mobile failure, `P1` for high-impact device/accessibility risk, `P2` for important quality gaps, and `P3` for polish or documentation.

### P1: User scaling is disabled

`frontend/index.html` sets `user-scalable=no` and `maximum-scale=1.0`. This prevents users with low vision from zooming the interface in Safari and Chrome. The 16px form-control rule addresses automatic input zoom, but it does not justify disabling manual zoom.

**Recommendation:** remove `user-scalable=no` and `maximum-scale=1.0`; retain the 16px mobile form-control rule and verify that layout remains stable at 200% browser zoom.

### P1: Touch target compliance is not proven

The header uses `h-9 w-9` icon buttons, and the CSS explicitly allows compact controls to avoid a 44px minimum. This may be a deliberate visual choice, but the current tests inspect naming and overflow, not physical hit rectangles or spacing between adjacent controls.

**Recommendation:** measure every interactive rectangle on phone viewports. Prefer a 44x44px effective hit target, even if the icon itself remains 16-20px. At minimum, verify no adjacent header actions have overlapping or ambiguous hit regions.

### P1: Voice behavior is untested on mobile browsers

The product has a substantial voice surface, but the current browser tests do not exercise microphone permission or `MediaDevices` behavior. iOS Safari and Android Chrome differ on permission prompts, backgrounding, Bluetooth route changes, audio focus, interruption by phone calls, and whether a page is in browser or standalone mode.

**Recommendation:** add real-device scenarios for first permission, denied permission, previously denied permission, no microphone, Bluetooth headset connect/disconnect, screen lock, app switch, incoming call interruption, network loss, mute, captions, hangup, and crisis handoff. Verify the UI never says “Listening” before the voice setup is complete.

### P1: Full-height keyboard behavior is not validated

The app relies on `interactive-widget=resizes-content`, `visualViewport`, `100dvh`, and `--app-height`. These are promising safeguards, but the automated audit never focuses the textarea, opens a modal with the keyboard visible, types long content, or checks the composer above the home indicator while the keyboard is open.

**Recommendation:** test iOS Safari, iOS standalone, Android Chrome, and Android standalone with the keyboard open. Check that the send button remains visible, transcript scrolling remains usable, the focused field is not hidden, and closing the keyboard restores the original height without a jump.

### P2: WebKit and Android-specific automated coverage is absent

`tests/frontend_visual_audit.mjs` launches Playwright Chromium only. The report's `390x844` result is a viewport regression check, not an iPhone Safari check. It does not cover WebKit, Android Chrome, install mode, or device pixel ratio.

**Recommendation:** add Playwright WebKit coverage for iPhone-sized viewports and Chromium device profiles for Pixel-sized viewports. Keep the existing desktop and 390px checks, then add orientation and keyboard-focused scenarios.

### P2: PWA install metadata is incomplete for a polished mobile app

The manifest has name, start URL, scope, standalone display, portrait orientation, theme/background colors, and icons. It does not include `id`, `lang`, `dir`, `categories`, `shortcuts`, `screenshots`, or a richer maskable icon set. iOS also does not consume all Android manifest features, so Apple metadata remains important.

**Recommendation:** add manifest `id`, `lang`, `categories`, optional shortcuts for New chat and History, phone/tablet screenshots, and verify maskable icon safe zones. Test install, launch, uninstall, relaunch, update, and offline shell behavior on both platforms.

### P2: Theme metadata can drift from runtime theme

The HTML includes light and dark `theme-color` media declarations, while the manifest declares a single `theme_color` of `#4140FD`. Runtime theme changes update document classes and local storage but do not update the manifest and are not shown to change browser chrome color dynamically.

**Recommendation:** define a deliberate browser-chrome strategy for light/dark and standalone modes. Test status-bar contrast, splash/background color, navigation bar color, and theme switching after install.

### P2: Transcript live-region strategy is known to be noisy

The frontend map explicitly records `role="log"` plus `aria-live` on the full transcript as a known product-integrity gap. Streaming assistant text can cause repeated announcements, which is especially disruptive with VoiceOver and TalkBack.

**Recommendation:** keep the transcript structurally navigable, but announce only message completion or a concise status update in a separate live region. Test streaming, stop generation, errors, voice captions, and long messages with VoiceOver and TalkBack.

### P2: Modal and menu behavior needs mobile assistive-technology verification

Focus trapping exists, and the mobile header menu uses `role="menu"`, but automated checks do not validate focus return, screen-reader announcements, back-button dismissal, or touch dismissal. Stacked Settings and Memory overlays increase the risk of focus ownership bugs.

**Recommendation:** verify Escape, Android back, backdrop tap, close button, focus return, scroll locking, nested Memory-over-Settings focus ownership, and orientation changes while a dialog is open.

### P2: Orientation support is intentionally portrait-first but not fully specified

The manifest requests `portrait-primary`, while CSS and viewport listeners handle orientation changes. The product behavior in landscape is not defined in the current audit.

**Recommendation:** decide whether landscape should be blocked, supported, or gracefully letterboxed. If supported, test 667x375-class iPhone landscape and 800x360-class Android landscape, particularly the header, composer, voice overlay, modals, and keyboard.

### P2: Network and lifecycle resilience requires mobile testing

Chat streams, voice sockets, auth, memory, and recap persistence all have asynchronous behavior. Mobile browsers suspend tabs, reclaim memory, change networks, and interrupt audio more aggressively than desktop browsers.

**Recommendation:** test background/foreground, lock/unlock, tab discard/reload, flaky Wi-Fi to cellular transition, offline/online recovery, stream abort, duplicate send prevention, and draft retention. Record whether the user can recover without losing typed content.

### P3: Existing viewport documentation is stale

`docs/frontend/pwa-viewport-safearea.md` describes an inline `index.html` height script and older metadata values. The current height logic is in `frontend/src/main.tsx`; the current HTML uses `apple-mobile-web-app-status-bar-style=default`, and the current manifest colors differ from the examples in the document.

**Recommendation:** update or label the document as historical. Treat `frontend/index.html`, `frontend/src/main.tsx`, `frontend/css/style.css`, and `frontend/site.webmanifest` as the source of truth.

### P3: External Google Fonts create a mobile startup dependency

The HTML preconnects to Google Fonts and loads Inter from Google. This can delay font stabilization or fall back differently on poor mobile connections. It also adds a third-party request before the app is fully settled.

**Recommendation:** decide whether the product requires the external font. If yes, test slow 3G and offline fallback. If typography is product-critical, self-host a subset with a controlled `font-display` strategy.

## Platform Matrix

| Area | iOS Safari | iOS standalone | Android Chrome | Android standalone |
|---|---|---|---|---|
| Safe top inset | Test notch/status bar and address-bar transitions | Test status-bar style and launch splash | Test cutouts and status/navigation bar | Test edge-to-edge launch and navigation bar |
| Bottom inset | Test home indicator and keyboard | Test home indicator without browser chrome | Test gesture navigation and 3-button navigation | Test gesture/navigation bar color and inset |
| Viewport | Test URL bar collapse/expand and `visualViewport` | Test launch and resume heights | Test dynamic toolbar and keyboard resize | Test installed task resume and viewport restoration |
| Input | Test 16px no auto-zoom and selection handles | Test same with standalone keyboard | Test autofill, selection, back button | Test keyboard dismissal and task switching |
| Voice | Test permission, WebKit audio, interruptions, Bluetooth | Test standalone microphone lifecycle | Test permission, audio focus, Bluetooth | Test background and resume behavior |
| Dialogs | Test VoiceOver, swipe navigation, backdrop, focus return | Test same after orientation/background | Test TalkBack, back button, focus return | Test same after task switching |
| PWA | Add to Home Screen and relaunch | update/uninstall/reinstall | install prompt and shortcuts | update/uninstall/reinstall |

## Required Device Test Set

### iOS

- iPhone SE-class: 375x667
- iPhone 14/15-class: 390x844 or 393x852
- iPhone Pro Max-class: 430x932
- iPad portrait: 768x1024
- iPad landscape: 1024x768
- Latest supported iOS Safari and one prior major version

### Android

- Small phone: 360x640
- Pixel-class phone: 412x915
- Tall phone with gesture navigation: 390x844 or equivalent
- Android tablet portrait and landscape
- Latest supported Chrome and one prior major version

## Test Scenarios

### Core layout

- First load in light and dark theme.
- Reload after theme selection.
- Browser toolbar expanded and collapsed.
- Portrait to landscape and back.
- Smallest supported width with long localized labels.
- 200% text/browser zoom without clipping or hidden controls.
- No horizontal overflow and no fixed element behind a system inset.

### Chat and composer

- Focus empty composer, type a long multiline message, scroll within it, expand, collapse, send, and edit.
- Open keyboard while a long assistant response is visible.
- Stop a streaming response, recover from a stream error, and retry.
- Rotate while text is drafted.
- Background the app during generation and return.
- Verify send, stop, expand, model picker, dictation, and voice controls have stable hit targets.

### Navigation and dialogs

- Open mobile More actions, select every item, tap outside, press Back/Escape, and rotate.
- Open History, search, clear search, open a session, and close.
- Open Settings, change categories, open Memory over Settings, close in both orders.
- Open authentication from guest and signed-in states.
- Verify focus return and screen-reader labels for every dialog and menu.

### Voice

- Consent, connecting, setup complete, listening, speaking, holding, unavailable, error, and hangup states.
- Allow, deny, revoke, and previously deny microphone access.
- No microphone, Bluetooth headset, route change, phone call interruption, app switch, lock screen, and network loss.
- Captions on/off, mute/unmute, crisis support, resource handoff, and recap.
- Reduced motion enabled and disabled.

### PWA and lifecycle

- Install from Safari and Chrome.
- Launch from home screen, cold start, warm resume, and after OS task termination.
- Verify icons, splash/background, status/navigation bar contrast, orientation, and theme.
- Offline shell, stale API response, reconnect, update, uninstall, and reinstall.

## Automated Coverage To Add

The existing tests should remain, but add a mobile-specific suite with these assertions:

1. Playwright WebKit at iPhone-sized viewports.
2. Chromium Android device profiles at small-phone and Pixel-sized viewports.
3. Geometry assertion that interactive controls have a 44px effective target or documented exception.
4. Focus textarea and assert the composer and send action remain inside the visual viewport.
5. Simulate `visualViewport` resize and orientation change; assert `--app-height` and `--keyboard-offset` update.
6. Assert no fixed overlay or composer intersects the safe-area bounds in supported emulation.
7. Assert menu/dialog focus return and Android-style Back behavior where the harness can model it.
8. Assert `prefers-reduced-motion` suppresses nonessential animation.
9. Assert transcript announcements are bounded during streaming.
10. Assert voice permission-denied and setup-error states remain actionable and honest.

## Release Gates

### Must pass before calling mobile-ready

- No keyboard-induced overlap on iOS Safari, iOS standalone, Android Chrome, and Android standalone.
- No control smaller than 44px effective touch area without an intentional, tested exception.
- No content under the notch, status bar, home indicator, or Android navigation area.
- Voice permission denial and interruption paths are recoverable.
- VoiceOver and TalkBack can navigate chat, composer, dialogs, menus, and crisis surfaces.
- User zoom works at 200%.
- Install, launch, resume, update, and uninstall work on both platforms.
- No console errors, page errors, failed requests, or lost drafts in the mobile regression suite.

### Current evidence

- Existing visual audit: 18/18 checks passed for Chromium desktop and 390x844 viewport scenarios.
- Existing quality harness exercises key controls, auth, history, model selection, and mocked chat streaming.
- Existing code contains safe-area, dynamic viewport, reduced-motion, focus-trap, and standalone-mode implementations.

### Evidence still required

- Real iOS Safari and WebKit results.
- Real Android Chrome results.
- Installed PWA results on both platforms.
- Physical touch-target measurements.
- Keyboard/rotation/background/audio interruption results.
- Voice permission and Bluetooth results.
- VoiceOver and TalkBack results.

## Overall Assessment

**Status: mobile foundation ready for targeted device validation; not yet proven iOS/Android production-ready.**

The implementation is thoughtfully prepared for mobile, especially around viewport height, safe areas, composer sizing, modals, and voice state honesty. The next work should be a focused mobile validation pass and a small set of accessibility/PWA corrections, led by removing the zoom restriction, proving effective touch targets, and exercising real WebKit/Android keyboard and microphone behavior.