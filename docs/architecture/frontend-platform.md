# MindPal Frontend Design System & Technology Stack Architecture

**Status:** Architecture Specification & Platform Blueprint (v5.0.0)
**Complements:** `docs/architecture/backend-platform.md`
**Target:** OpenAI ChatGPT Canvas / Google Gemini 2026 Tier-1 User Experience

---

## 1. Primary Technology Stack Choice (Option A: React 19 + TypeScript)

To achieve a high-end, responsive, and secure experience comparable to OpenAI Canvas and Google Gemini, MindPal adopts **Option A: React 19 + TypeScript + Vite + Zustand + Framer Motion**.

### 1.1 Stack Matrix & Architectural Justification

| Layer | Choice | Rationale / Google & OpenAI Pattern |
|---|---|---|
| **Framework** | **React 19 + TypeScript 5** | Strict compile-time typing, Concurrent Rendering, and automated DOM reconciliation. |
| **Build System** | **Vite + SWC** | Sub-second HMR, tree-shaking, and code splitting (CLS < 0.01, LCP < 1.2s). |
| **State Management** | **Zustand** | Lightweight (<2KB) unidirectional reactive state store with zero boilerplate. |
| **Design & Tokens** | **Tailwind CSS v4 + Radix UI** | Tokenized CSS variables, accessible headless primitives, and Material You 3 color scales. |
| **Animations** | **Framer Motion 11** | Spring physics micro-interactions (`stiffness: 300, damping: 30`), layout transitions. |
| **API Binding** | **OpenAPI-TS Client** | Direct code generation from `contracts/openapi.yaml` yielding 100% typed query/mutation hooks. |

---

## 2. Zero-Trust Security & Anti-Leak Frontend Defense Architecture

MindPal handles sensitive reflective conversations and clinical disclosures. The frontend enforces a **Zero-Leak, Zero-Trust Defense in Depth** policy.

### 2.1 Content Security & Sanitization (Zero XSS)
* **Strict CSP (Content Security Policy):** `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none';`.
* **DOMPurify Markdown Pipeline:** All rendered LLM responses pass through DOMPurify with strict HTML tag allowlists before injection into the DOM. Raw `dangerouslySetInnerHTML` is banned unless wrapped in sanitized view components.

### 2.2 Client-Side Data Privacy & Memory Hygiene (Zero Data Leakage)
* **Non-Persisted Memory Buffers:** Unencrypted chat messages and bearer tokens are held strictly in in-memory state stores (`Zustand`) and never stored in unencrypted `localStorage` or `sessionStorage`.
* **Automatic Session Cleansing:** Session stores reset state immediately on logout, tab closure, or 15 minutes of user inactivity.
* **Sensitive Telemetry Scrubbing:** Local telemetry and console logs redact basic PII, emails, and authentication tokens before emitting events to observability endpoints.

---

## 3. High-End Responsive UX & Device Compatibility

MindPal provides a fluid, high-end experience across mobile (iOS/Android), tablet, desktop, and foldable screens.

### 3.1 Mobile Safe Area & Viewport Handling (`100dvh`)
* **Dynamic Viewport Height:** Modals, chat canvases, and voice overlays use `min-h-[100dvh]` and `env(safe-area-inset-bottom)` to prevent dynamic mobile browser bars (iOS Safari / Chrome Android) from clipping composer controls.
* **Stack Navigation Pattern:** On viewports `< 768px`, modal dialogs (such as Settings) automatically transition into native-feeling slide-over stack views with top back-buttons rather than nested dropdowns.

### 3.2 Real-Time SSE Token Stream Rendering
* **Auto-Scroll Lock & Smooth Yielding:** SSE token chunks are buffered via `requestAnimationFrame` to ensure 60fps frame rates during fast token generation, automatically locking scroll to bottom unless the user manually scrolls up.

---

## 4. Design Language & Design System Specifications

### 4.1 Visual Tokens & Color Palette

```text
┌────────────────────────────────────────────────────────────────────────┐
│                              DESIGN TOKENS                             │
│  Typography (Inter/SF Pro) │ Color Palette (Slate/Indigo) │ Motion │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│                       REACTIVE ZUSTAND STORE                           │
│     Session Store  │  Memory Store  │  Voice Store  │  Theme Store     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│                    CONTRACT-BOUND API GATEWAY                          │
│          Generated TypeScript OpenAPI Client (contracts/)              │
└───────────────────────────────────┬────────────────────────────────────┘
```

| Element | Standard | Specification |
|---|---|---|
| **Typography** | Dynamic Fluid Scale | Display (32px/1.2), Heading (20px/1.3), Body (15px/1.6), Code (13px/1.4 Monospace) |
| **Color Palette** | Slate & Deep Indigo | Dark Mode: `#0F172A` background, `#1E293B` surfaces, `#3B82F6` focus rings |
| **Elevation** | Ambient Soft Shadow | Layer 1 (`shadow-sm`), Layer 2 (`shadow-md`), Modal Overlay (`shadow-2xl` with backdrop blur `12px`) |
| **Motion** | Spring Physics | `transition: all 200ms cubic-bezier(0.16, 1, 0.3, 1)` for fluid micro-interactions |
| **Accessibility** | WCAG 2.1 AAA | Mandatory `focus-visible:ring-2 focus-visible:ring-blue-500` on all interactive controls |

---

## 5. Architectural Invariants for Frontend Code

1. **OpenAPI 1:1 Contract Binding:** The frontend MUST NOT invoke arbitrary HTTP paths. All API interactions pass through `frontend/js/api/client.js` generated directly from `contracts/openapi.yaml`.
2. **Unidirectional Data Flow:** Views emit actions to the Zustand store; the store mutates state deterministically; views re-render reactively.
3. **Accessible by Default:** Every interactive button, input, and toggle defines explicit keyboard focus states (`:focus-visible`), ARIA roles, and readable contrast ratios.
4. **Zero Layout Shifts (CLS < 0.01):** Skeleton loaders and reserved dimensions must be used for dynamic content.
5. **Zero Artifact Modifications:** Build artifacts in `frontend/dist/` are generated via `npm run build` and never edited directly.
