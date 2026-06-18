# Mobile & PWA — Viewport & Safe Areas

MindPal is designed as a Progressive Web App (PWA) that works in Safari, Chrome, and when added to the iPhone home screen (standalone mode).

## PWA Configuration

### Manifest (`frontend/site.webmanifest`)
```json
{
  "display": "standalone",
  "orientation": "portrait-primary",
  "background_color": "#f8fafc",
  "theme_color": "#0f172a"
}
```

### Meta Tags (`frontend/index.html`)
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="MindPal">
<meta name="mobile-web-app-capable" content="yes">
```

**Key viewport attributes**:
- `viewport-fit=cover` — extends content behind the notch/home indicator
- `interactive-widget=resizes-content` — keyboard properly resizes viewport on Safari
- `user-scalable=no` — prevents zoom on input focus

---

## Viewport Height Fix

### The Problem
iOS Safari and standalone mode handle `100vh` differently:
- **Safari browser**: `100vh` = full viewport including hidden URL/bottom bars → content overflows
- **Standalone mode**: `100vh` sometimes reports incorrect values on older iOS

### The Solution — Triple Fallback

**CSS** (`frontend/css/style.css`):
```css
:root {
  --app-height: 100vh;          /* JS-set, most reliable */
}
.h-dvh-safe {
  height: 100vh;                /* Fallback 1: classic */
  height: 100dvh;               /* Fallback 2: dynamic viewport height */
  height: var(--app-height);    /* Fallback 3: JS-measured (wins) */
}
```

**JS** (inline script in `index.html`):
```javascript
function setAppHeight() {
  document.documentElement.style.setProperty('--app-height', window.innerHeight + 'px');
}
setAppHeight();
window.addEventListener('resize', setAppHeight);
window.addEventListener('orientationchange', () => setTimeout(setAppHeight, 150));
```

The JS runs early (before app bootstrap) and updates on every resize/orientation change.

---

## Standalone Mode Detection

```javascript
var isStandalone = window.navigator.standalone === true       // iOS Safari
    || window.matchMedia('(display-mode: standalone)').matches; // Android/Chrome
if (isStandalone) {
  document.body.classList.add('standalone');
}
```

This allows CSS to target standalone-specific layout needs.

---

## Safe Area Insets

### Top (Status Bar)
In standalone mode with `black-translucent` status bar, content extends behind the status bar. The header needs padding to push its content below:

```css
@supports (padding-top: env(safe-area-inset-top)) {
  .pt-safe {
    padding-top: env(safe-area-inset-top) !important;
  }
  #main-content {
    padding-top: calc(72px + env(safe-area-inset-top)) !important;
  }
}
```

- `pt-safe` is applied to the `<header>` element
- `#main-content` gets an auto-adjusted top padding: 72px (header height) + status bar inset

### Bottom (Home Indicator)
iPhone X+ has a home indicator bar at the bottom. The input area needs padding above it:

```css
@supports (padding-bottom: env(safe-area-inset-bottom)) {
  .pb-safe {
    padding-bottom: max(1.5rem, env(safe-area-inset-bottom)) !important;
  }
}
```

- `pb-safe` is applied to the `#interaction-area` element
- Uses `max()` to ensure at least 1.5rem even on devices without a home indicator

---

## Responsive Breakpoints

| Breakpoint | Width | Text alignment | Mood buttons |
|-----------|-------|----------------|--------------|
| Default (phones) | < 640px | Left-aligned | Wrap, left |
| `sm` | 640px+ | Centered | Centered |
| `md` | 768px+ | Centered | Centered, all in row |

### Greeting text sizes
- Default: `text-4xl` (36px)
- `sm`: `text-5xl` (48px)

### Loading text sizes
- Default: `text-3xl` (30px)
- `sm`: `text-4xl` (36px)
- `md`: `text-5xl` (48px)

---

## Tested Device Sizes

| Device | Viewport | Status |
|--------|----------|--------|
| iPhone SE | 375×667 | ✅ |
| iPhone 14 Pro | 393×852 | ✅ |
| Small Android | 360×640 | ✅ |
| iPad | 768×1024 | ✅ |
