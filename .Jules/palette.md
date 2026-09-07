## 2026-08-23 - Accessibility ARIA Labels for Icon-Only Navigation & Control Buttons
**Learning:** Icon-only buttons lacking `aria-label` attributes present accessibility barriers for screen reader users, preventing them from understanding the interactive context of action controls (e.g. theme toggle, daily streak progress, user profile, send message, voice input, modal close buttons).
**Action:** Always provide explicit, concise `aria-label` attributes for icon-only `<button>` elements across application templates and dynamic components.

## 2026-08-30 - Focus-Visible Ring Indicators on Dynamically Injected Action Controls
**Learning:** Dynamic action controls injected via JavaScript string templates (such as chat response buttons: play, copy, like, dislike, retry) often miss focus indicator classes if not specified in the HTML template, leaving keyboard-only and screen-reader users without focus feedback during tab navigation.
**Action:** Include `focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none` on all dynamically generated interactive element templates.
