# Voice full-text highlight verification — 2026-08-21

The canonical production URL `https://mindpal-demo.vercel.app/` was opened without a query string after deployment `dpl_GaGykWER4xaJc7782Wj9A2aZCB5v` for commit `da519ef`.

In the connected browser, the Voice session reached `MindPal is speaking…`. The caption area showed complete assistant responses rather than only the newest transcript chunk. The currently spoken range was visibly highlighted: in the response `I'm doing pretty well, thanks for asking! Just here ready to chat. How about you? Everything good on your end?`, the phrase `I'm doing pretty well, thanks` was highlighted while the remainder stayed visible with lower emphasis. Earlier caption lines also showed their currently spoken words highlighted.

This confirms the intended behavior: assistant text is visible immediately as a complete response, while playback pacing advances the spoken highlight. The test used the normal canonical URL; no cache-busting query parameter was required.

Validation before deployment: 156 JavaScript tests passed, 177 Python tests passed, frontend build passed, and the prebuilt frontend verifier passed.
