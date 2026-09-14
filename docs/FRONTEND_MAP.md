# Frontend map

The client is a React 19 SPA in `frontend/src/`, bundled with esbuild, styled with Tailwind and `frontend/css/brand-tokens.css`. State is Zustand. HTTP goes through `frontend/src/services/api/`.

Do not treat `frontend/js/` or `archive/frontend-legacy-*` as current.

## Surfaces

| Surface | Entry | Notes |
|---|---|---|
| Shell | `App.tsx`, `components/app/AppPanels.tsx` | Header, tab bar, error boundary, skip link |
| Chat | `components/chat/canvas/*`, `components/chat/input/*` | Empty greeting + mood chips; thread + composer |
| History | `components/chat/history/*` | Session list; persistence is primarily local |
| Settings | `components/settings/*` | Tabbed modal |
| Auth | `components/auth/*` | Firebase email / Google / phone |
| Voice overlay | `components/voice/VoiceOverlay.tsx` | Live-call chrome; must not imply a duplex session unless the token + media path is real |
| Presence | `components/presence/*` | Flag-gated; waitlist must be a real intake or stay gated |
| Memory inspector | `components/memory/*` | Opened from header/settings |

## Stores (`frontend/src/store/`)

`chat`, `auth`, `settings`, `history`, `voice`, `flags`, `memory`, `streak`, `toast`, `modals`, `usage`, `session`, `changelog`.

## Known product-integrity gaps (do not paper over)

- Composer stop does not abort `/api/chat/stream` (store has `stopGeneration`; send path does not wire `AbortController`).
- Two composer mounts (empty vs thread) share one ref via remount.
- Chat canvas always auto-scrolls; no “user scrolled up” lock.
- Presence access is `localStorage` waitlist unless a backend intake exists.
- Usage / quota copy still describes limits while showing “Preview / Unlimited”.
- Account settings expose a truncated Firebase UID.
- `role="log"` plus `aria-live` on the full transcript is noisy for assistive tech.
