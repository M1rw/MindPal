# Settings UI

The Settings modal is a multi-tab panel (`#profile-modal`) built with vanilla JS and CSS.
It covers user preferences, clinical insights, usage tracking, memory management,
data controls, security, and account management.

## Tab Order

| # | Tab ID | Icon | Purpose |
|---|--------|------|---------|
| 1 | `general` | `settings` | Appearance, language, accent color, contrast, notifications |
| 2 | `mental-health` | `brain` | PHQ-9 / GAD-7 charts, problems, diagnoses, treatment plan |
| 3 | `usage` | `gauge` | 5-hour + weekly credit windows, progress bars, reset timers |
| 4 | `memory` | `database` | AI-generated memory summary + editable memory atoms |
| 5 | `data` | `database-zap` | Export data, clear conversations |
| 6 | `security` | `shield-alert` | Safety lock, content filters |
| 7 | `account` | `circle-user-round` | Cloud sync, sign in/out, delete account |

## File Locations

| File | Responsibility |
|------|---------------|
| `frontend/index.html` | Tab buttons, mobile dropdown, panel markup |
| `frontend/css/style.css` | `.settings-row`, `.settings-tab-btn`, `.settings-section` styles |
| `frontend/js/components/settings_ui.js` | Dynamic control rendering, dropdown binding, persistence |
| `frontend/js/settings_store.js` | `DEFAULT_APP_SETTINGS`, `getSetting()`, `updateSetting()`, persistence |
| `frontend/js/app.js` → `bindSettingsTabs()` | Tab switch logic, triggers `renderMemoryInspector()` / `renderUsagePanel()` |

## Settings Row Anatomy

```html
<div class="settings-row">
  <span class="settings-row-main">
    <span class="settings-row-title">Title</span>
    <span class="settings-row-copy">Description text under the title.</span>
  </span>
  <!-- One of: toggle, dropdown, action button, or plain text -->
</div>
```

### Styling Rules

- `.settings-row` has `border-bottom: 1px solid`.
- `.settings-row:last-child` has **no border** (no trailing line in any section).
- `.settings-row-block` has **no border** (used for grouped content like charts, progress bars).
- Padding is auto-sized — no rigid `min-width` on dropdown triggers.

## Dropdown Controls

Custom dropdown (no native `<select>`):
- Click the **trigger element** to open.
- Clicking the **label text** does NOT toggle the dropdown — only the trigger itself.
- Options appear as a floating panel and close on selection or outside click.

## Notifications System

Settings-driven browser notifications. Controlled in General tab.

| Setting Key | Default | Behavior |
|------------|---------|----------|
| `streakReminders` | `true` | Daily streak reminder if user hasn't chatted |
| `responseComplete` | `true` | Notifies when MindPal finishes a response |
| `moodCheckIn` | `false` | Periodic mood check-in reminders |

Implementation: `frontend/js/components/notifications.js`

- `initNotifications()` — requests permission, sets up reminders.
- `notifyResponseComplete()` — fires after stream completes if tab is not focused.
- `notifyFromSetting(key, title, body)` — checks setting before sending.
- Uses `Notification API` — only fires when document is not visible.

## Memory Inspector (Memory Tab)

When the Memory tab opens, `renderMemoryInspector()` generates:

1. **AI summary** — `generateMemorySummary(cards)` builds a natural-language paragraph
   from memory atoms. No bold text — all uniform font weight.
2. **Manage button** — opens a modal with editable memory atom cards (edit, pin, delete per item).
3. Item count is hidden from the summary display (user requested no "remembers X items" text).

Implementation: `frontend/js/components/memory_inspector.js`
