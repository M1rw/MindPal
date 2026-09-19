# Frontend map

The client is a React 19 SPA in `frontend/src/`, bundled with esbuild, styled with Tailwind and `frontend/css/brand-tokens.css`. State is Zustand. HTTP goes through `frontend/src/services/api/`.

Do not treat `frontend/js/` or `archive/frontend-legacy-*` as current.

## Surfaces

| Surface | Entry | Notes |
|---|---|---|
| Shell | `App.tsx`, `components/app/AppPanels.tsx` | Thin in-flow header; history/theme/streak overflow on small screens; tab bar sits in the header when Presence is on. The profile control opens Settings for guests and signed-in users (sign-in lives on Account and in tab CTAs). |
| Chat | `components/chat/canvas/*`, `components/chat/input/*` | One composer; Expand grows the field when it hits the 200px cap; empty greeting + mood chips; thread (reading text + soft user chip; hover/focus on the user bubble, not the full row); in-place user-message edit (later replies stay until Send); stop-abort; Standard/Pro picker (1 vs 2 credits, same Gemini model, locked while generating); quiet memory receipt after a turn when atoms were saved |
| History | `components/chat/history/*` | Shared `Modal`; chat icon per row; persistence is primarily local |
| Settings | `components/settings/*` | Tabbed `Modal` with flattened rows and custom listboxes (not native `<select>`). Opening Memory from Personalization stacks the inspector on top; Settings stays mounted. Data controls Download/Delete call `GET /api/user/export` and `DELETE /api/user/data` for the signed-in account only. Mental health and Analytics read `GET /api/user/wellness-timeline` when signed in (coarse mood/themes/events from saved memory and synced chats). Guests see this-device chats and guest facts only. |
| Auth | `components/auth/*` | Firebase email / Google / phone; shared `Modal` |
| Voice overlay | `components/voice/VoiceOverlay.tsx` | Mounted only when `voice_enabled` and the user starts a call. Consent/connecting/error stay honest — never “Listening” until Gemini `setupComplete`. Live captions come from session transcripts, not a canned greeting. Presence is the face only; the orb responds to speech rhythm and volume, not emotion detection. Distress keeps the call up (“Still with you”) with 988 available; the pause wall is only for imminent danger, an ask to leave, or a dead audio path. A reserved call lasts up to 30 minutes on one Live socket. After hangup, a recap of what was said is written into chat unless the call was a crisis handoff. Guests see sign-in before the microphone CTA. |
| Presence | `components/presence/*` | Off by default; waitlist is localStorage theater until a real intake exists |
| Memory inspector | `components/memory/*` | Opened from settings (stacked above Settings), or Review on a save receipt (atoms tab, highlighted ids). Compact saved-facts list with search, inline edit (`PATCH /api/memory/graph/items/{id}` for accounts; on-device graph for guests), and delete. Shared `Modal`. |
| Streak | `components/streak/StreakModal.tsx` | Consecutive days you sent a message. Guests: this device. Signed-in: `/api/user/insights`. Shared `Modal`. |
| Modal shell | `components/ui/Modal.tsx` | One overlay chrome (header, close, sizes). Customize content; do not restyle radius/kicker/close per screen. |

## Stores (`frontend/src/store/`)

`chat`, `auth`, `settings`, `history`, `voice`, `flags`, `memory`, `streak`, `toast`, `modals`, `usage`, `session`, `changelog`.

## Known product-integrity gaps (do not paper over)

- Presence remains `localStorage` waitlist theater if the flag is turned on.
- `role="log"` plus `aria-live` on the full transcript is noisy for assistive tech.
- Usage credits appear in Settings only after the first successful or limited chat response.
- Guest memory is on-device until sign-in. Chat turns for guests do not inject that graph into the model prompt.
