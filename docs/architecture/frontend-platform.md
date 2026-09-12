# MindPal Frontend Design System & Platform Architecture

**Status:** Architecture Specification & Blueprint (v5.0.0)
**Complements:** `docs/architecture/backend-platform.md`
**Target:** OpenAI ChatGPT Canvas / Google Gemini 2026 Tier-1 User Experience

---

## 1. Deep Audit & Post-Mortem of Current Frontend Flaws

An in-depth architectural audit of `frontend/` revealed several anti-patterns that make MindPal look like a prototype rather than a world-class production web application:

### 1.1 Imperative DOM Spaghetti & Global State Pollution
* **Legacy Flaw:** UI states are modified via scattered direct DOM queries (`document.getElementById(...)`) across `frontend/js/app/main.js` (1000+ lines), `bootstrap.js`, and `ui_state.js`.
* **Consequence:** Race conditions occur during streaming, UI components desynchronize from backend state, and DOM updates trigger excessive layout reflows.

### 1.2 Hand-Coded `fetch()` Calls & URL Drift
* **Legacy Flaw:** Features make raw `fetch('/api/...')` calls with hardcoded strings rather than consuming a typed client generated from `contracts/openapi.yaml`.
* **Consequence:** API contract drift occurs silently on the client, breaking error handling and payload parsing.

### 1.3 Design System Inconsistency & Token Fragmentation
* **Legacy Flaw:** UI components mix custom CSS rules (`style.css`), utility-first Tailwind classes, inline styles, and manual color definitions without design tokens.
* **Consequence:** Inconsistent spacing scales, mismatched dark mode contrast ratios, abrupt non-spring animations, and lack of visual polish compared to OpenAI Canvas or Google Gemini.

### 1.4 Accessibility & Focus Indicator Gaps
* **Legacy Flaw:** Modals, overlays, and chat action buttons lack unified `:focus-visible` keyboard rings, ARIA live regions for streaming text, and semantic landmark tags.
* **Consequence:** Poor keyboard navigation experience and failure to comply with WCAG 2.1 AA standards.

---

## 2. World-Class Google / OpenAI 2026 Design System

MindPal's frontend adopts a high-polish **Canvas & Generative Intelligence Design Language** inspired by Google Material You 3 and OpenAI ChatGPT UI.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                              DESIGN TOKENS                             │
│  Typography (Inter/SF Pro) │ Color Palette (Slate/Indigo) │ Motion │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│                       REACTIVE STATE MACHINE                           │
│     Session Store  │  Memory Store  │  Voice Store  │  Theme Store     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│                    CONTRACT-BOUND API GATEWAY                          │
│          Generated TypeScript/JS OpenAPI Client (contracts/)           │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│                        COMPONENT SYSTEM (UI)                           │
│  Chat Canvas  │  Voice Overlay  │  Memory Modal  │  Settings Panel     │
└────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Design Language Specifications

| Element | Standard | Specification |
|---|---|---|
| **Typography** | Dynamic Fluid Scale | Display (32px/1.2), Heading (20px/1.3), Body (15px/1.6), Code (13px/1.4 Monospace) |
| **Color Palette** | Slate & Deep Indigo | Dark Mode: `#0F172A` background, `#1E293B` surfaces, `#3B82F6` focus rings |
| **Elevation** | Ambient Soft Shadow | Layer 1 (`shadow-sm`), Layer 2 (`shadow-md`), Modal Overlay (`shadow-2xl` with backdrop blur `12px`) |
| **Motion** | Cubic-Bezier Springs | `transition: all 200ms cubic-bezier(0.16, 1, 0.3, 1)` for fluid micro-interactions |
| **Accessibility** | WCAG 2.1 AA | Mandatory `focus-visible:ring-2 focus-visible:ring-blue-500` on all interactive controls |

---

## 3. Frontend Target Architecture

```text
frontend/
  assets/                     # Static brand graphics and icons
  css/
    tokens.css                # Single source of truth for CSS variables & design tokens
    style.css                 # Base resets, typography, and utility extensions
  js/
    api/                      # OpenAPI 1:1 Client Gateway (bound to contracts/openapi.yaml)
      client.js
    state/                    # Unidirectional Reactive Store
      store.js                # App State Machine
      modules/
        chat_store.js
        memory_store.js
        voice_store.js
        settings_store.js
    ui/                       # Modular Component Controllers
      components/
        chat_canvas.js        # Real-time token stream rendering & markdown parse
        voice_overlay.js      # WebRTC / Audio reactive visualizer
        memory_modal.js       # Narrative memory profile viewer
        settings_panel.js     # Modular settings tab navigation
    utils/                    # Helper utilities (DOM, sanitization, dates, icons)
      dom.js
      icons.js
  components/                 # HTML view fragments (assembled into index.html)
    chat/
    modals/
    voice/
  index.template.html         # Template root for HTML assembly
```

---

## 4. Architectural Invariants for the Frontend

1. **OpenAPI 1:1 Contract Binding:** The frontend MUST NOT invoke arbitrary HTTP paths. All API interactions pass through `frontend/js/api/client.js` generated or mapped directly from `contracts/openapi.yaml`.
2. **Unidirectional Data Flow:** Views emit actions to the store; the store mutates state deterministically; views re-render reactively.
3. **Accessible by Default:** Every interactive button, input, and toggle defines explicit keyboard focus states (`:focus-visible`), ARIA roles, and readable contrast ratios.
4. **Zero Layout Shifts (CLS < 0.05):** Skeleton loaders and reserved dimensions must be used for dynamic content (chats, summaries, settings).
5. **Real Streaming UI:** SSE streams yield tokens incrementally into an append-buffer with smooth auto-scroll lock.
