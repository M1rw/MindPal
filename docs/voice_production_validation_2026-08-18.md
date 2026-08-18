# Voice Production Validation — 2026-08-18

## Release

| Item | Evidence |
|---|---|
| GitHub commits | `6d439e9` and `76737c8` pushed to `M1rw/MindPal` `main` |
| Production deployment | Vercel deployment `dpl_6koNsvn9XzVEovV6CtudEtmHp4nG` |
| Deployment state | `READY` |
| Deployed source revision | `76737c80b44c79f6a294a910e51433d2fa7b8de9` |

## Short Connected-Browser Validation

A fresh production tab was opened with `?voice-product-release=76737c8`. The production Voice overlay opened successfully and reached the permitted **Listening…** state. The provider’s greeting arrived and rendered as a large, assistant-only caption: “Good morning, Miljte, I hope you're having a great start to your day.” The overlay did not display a user transcript bubble, and the call was manually ended after the short check so the user’s microphone was not left active.

## Remaining Live Evidence

The following mechanics are validated deterministically and are deployed, but require elapsed wall-clock time and real user speech to certify in production: the two-minute inactivity spoken warning, three-minute inactivity end, twenty-eight-minute session warning, thirty-minute session end, live interruption, and provider GoAway/recovery through the new credential rate-limit policy.

The current Live provider supports provider-owned automatic VAD and post-setup `realtimeInput`; it does not expose proactive assistant audio while a person is still speaking. Accordingly, MindPal visibly remains in **Listening…** while the user speaks and delivers a brief natural acknowledgement after the provider declares a turn boundary, rather than faking unsupported simultaneous back-channel speech.

## Controlled Inactivity Observation

A second production session was opened without intentionally providing user speech and observed for just over two minutes. At that observation point, the overlay still showed **Listening…** and the greeting caption remained visible; the **Inactive** warning was not observed. Because this check ran against the connected browser’s real microphone, ambient input may have been classified as user activity. The three-minute end threshold was not yet observed at this point.
