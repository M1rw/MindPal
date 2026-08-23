## 2026-08-23 - Accessibility ARIA Labels for Icon-Only Navigation & Control Buttons
**Learning:** Icon-only buttons lacking `aria-label` attributes present accessibility barriers for screen reader users, preventing them from understanding the interactive context of action controls (e.g. theme toggle, daily streak progress, user profile, send message, voice input, modal close buttons).
**Action:** Always provide explicit, concise `aria-label` attributes for icon-only `<button>` elements across application templates and dynamic components.
