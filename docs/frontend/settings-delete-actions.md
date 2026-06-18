# Settings Panel — Delete Actions & Safety

## Settings Architecture

The settings modal is organized into tabs:
1. **General** — Theme, mode preferences, data controls
2. **Account** — Authentication, cloud sync, profile
3. **About** — Version info, privacy notice

## Delete Actions (Danger Zone)

### Delete All Chats and Memory

**Location**: General tab → Data section

**UI Structure**:
```html
<div class="settings-row">
  <span class="settings-row-main">
    <span class="settings-row-title text-rose-600">Delete all chats and memory</span>
    <span class="settings-row-copy">Clear local conversation cache and cloud memory if signed in.</span>
  </span>
  <button id="clear-chat-btn" class="settings-danger-pill">Delete all</button>
</div>
```

**Important**: The entire row is a `<div>`, NOT a `<button>`. Only the red "Delete all" pill is clickable. This prevents accidental deletion when users tap the description text.

**Flow**:
1. User clicks red "Delete all" pill
2. Confirmation dialog appears with title and warning
3. User must click "Delete all" in the dialog to confirm
4. On confirm:
   - Cloud memory deleted (if signed in)
   - Memory graph reset to empty
   - Cloud chat deleted (if signed in)
   - Local chat memory cleared
   - Chat history DOM cleared
   - Welcome screen restored

### Delete Account

**Location**: Account tab (only visible when signed in)

**UI Structure**: Same pattern — `<div>` row with `<button>` pill. Only the "Delete" button triggers the action.

## Settings Row Pattern

### Clickable Rows (Non-destructive)
For safe actions like "Export conversation log", the entire row is a `<button>`:
```html
<button id="export-chat-btn" class="settings-row text-left w-full">...</button>
```

### Destructive Rows
For dangerous actions, the row is a `<div>` with only the pill as a `<button>`:
```html
<div class="settings-row">
  ...descriptive text...
  <button id="clear-chat-btn" class="settings-danger-pill">Delete all</button>
</div>
```

**Rule**: Destructive actions MUST only trigger from the pill button, never from clicking the row text or description.

## Danger Pill Styling

```css
.settings-danger-pill {
  background: rgba(239, 68, 68, 0.08);
  color: #ef4444;
  font-weight: 600;
  padding: 6px 14px;
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.2s;
}
.settings-danger-pill:hover {
  background: rgba(239, 68, 68, 0.15);
}
```
