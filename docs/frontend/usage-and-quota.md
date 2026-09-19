# Usage & quota

Server-side credits for `POST /api/chat/stream`. Canonical backend page: [`docs/backend/quota-enforcement.md`](../backend/quota-enforcement.md).

| Reply mode | Credits | Model |
|------------|---------|-------|
| Standard | 1 | Same Gemini chat model (`gemini-2.5-flash`) |
| Pro | 2 | Same model; more thorough prompt |

The Usage settings tab reads the `usage` object from the chat stream. There is no local fake meter and no separate usage API.
