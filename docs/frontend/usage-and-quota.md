# Usage & Quota System

Unified credit-based rate limiting that applies across all model tiers.
Ensures fair usage for everyone based on dual rolling time windows.

## Credit Costs

| Model | Credits per Message |
|-------|-------------------|
| Standard | 1 credit |
| Pro | 2 credits |

## Time Windows

| Window | Limit | Reset |
|--------|-------|-------|
| 5-hour rolling | 50 credits | Resets 5 hours after first message in the window |
| 1-week rolling | 500 credits | Resets 7 days after first message in the window |

Both windows run independently. The **more restrictive** one applies.
When either limit is reached, the user is blocked until that window resets.

## Architecture

### Backend (Source of Truth for Authenticated Users)

**Model**: `backend/models/user.py` → `UsageProfile`

```python
class UsageProfile(BaseModel):
    pro_messages_count: int = 0          # Legacy — still tracked
    pro_last_reset_time: float = 0.0     # Legacy — still tracked
    total_credits_5h: int = 0            # Credits consumed in current 5h window
    total_credits_week: int = 0          # Credits consumed in current 1-week window
    five_hour_reset_time: float = 0.0    # Epoch when 5h window started
    week_reset_time: float = 0.0         # Epoch when 1-week window started
```

**Enforcement**: `backend/api/chat_stream_router.py`

1. Before streaming, checks both 5h and 1-week windows.
2. If either is exhausted, returns `quota_exceeded: true` in metadata.
3. On success, increments credits (1 or 2 based on model).
4. Emits `usage` metadata in every stream response with current state.

### Frontend (Local Tracking for Guests + UI)

**Module**: `frontend/js/components/usage_tracker.js`

#### Exports

| Function | Purpose |
|----------|---------|
| `initUsageTracker({ showToast })` | Load from localStorage, create quota banner |
| `canSendMessage(model)` | Pre-flight check — returns `false` if exhausted |
| `recordMessage(model)` | Increment local credits (guest tracking) |
| `syncFromBackend(usageObj)` | Update local state from backend stream metadata |
| `getUsageSummary()` | Returns current credits, limits, percentages, reset times |
| `renderUsagePanel()` | Update the Usage settings tab DOM |

#### Pre-flight Flow

```
User clicks Send
  → handleSend() in app.js
    → canSendMessage(currentModel)
      → If false: show toast + quota banner, return early
      → If true: proceed to API call
    → After successful stream:
      → recordMessage(currentModel)  // client-side tracking
      → syncFromBackend(meta.usage)  // if backend provides it
```

### Quota Banner

A notification bar that appears above the chat input when usage is exhausted.

- Amber background with alert icon.
- Shows remaining time until reset.
- Auto-hides when credits become available again.
- CSS class: `.quota-banner` in `style.css`.

### Usage Settings Tab

Located in Settings → Usage. Renders:

- **5-hour window**: Progress bar + `X / 50` text + reset countdown
- **Weekly window**: Progress bar + `X / 500` text + reset countdown
- **How credits work**: Explanation row
- **Total messages sent**: Lifetime counter

Progress bars change color:
- Default: accent color
- ≥70%: amber warning (`.warn`)
- 100%: red full (`.full`)

Panel refreshes live data via `renderUsagePanel()` every time the tab is opened.

## localStorage Key

`mindpal_usage_v1` — JSON with fields: `credits_5h`, `credits_5h_reset`,
`credits_week`, `credits_week_reset`, `total_messages`.
