# Quota Enforcement — Backend

Server-side rate limiting for the chat streaming API.
All enforcement happens in `backend/api/chat_stream_router.py`.

## Credit System

| Model | Credit Cost |
|-------|------------|
| Standard | 1 credit |
| Pro | 2 credits |

## Time Windows

| Window | Limit | Reset |
|--------|-------|-------|
| 5-hour | 50 credits | 5 hours after first message in window |
| 1-week | 500 credits | 7 days after first message in window |

## Enforcement Flow

```
1. Receive chat request with model selection
2. Load UsageProfile from Firestore (or defaults for guests)
3. Check if either window has expired → reset if so
4. Compute credit cost (1 for standard, 2 for pro)
5. If 5h credits + cost > 50 OR week credits + cost > 500:
   → Set quota_exceeded = true in metadata
   → If pro model, auto-downgrade to standard and retry
   → If still exceeded, return error
6. Increment credits
7. Save updated UsageProfile
8. Emit usage metadata in stream response
```

## Stream Metadata

Every successful stream includes a `usage` object:

```json
{
  "credits_5h": 12,
  "limit_5h": 50,
  "reset_5h_seconds": 14400,
  "credits_week": 45,
  "limit_week": 500,
  "reset_week_seconds": 504000,
  "total_messages": 234
}
```

The frontend `usage_tracker.js` consumes this via `syncFromBackend()`.

## Data Model

`backend/models/user.py` → `UsageProfile`:

```python
total_credits_5h: int = 0
total_credits_week: int = 0
five_hour_reset_time: float = 0.0
week_reset_time: float = 0.0
```

Legacy fields (`pro_messages_count`, `pro_last_reset_time`) are maintained
for backward compatibility but the new unified system takes precedence.
