# Frontend platform

**Status:** Current stack (matches `package.json`)

## Stack

| Layer | In use |
|---|---|
| UI | React 19 + TypeScript |
| Bundle | esbuild → `frontend/dist/app.bundle.js` |
| CSS | Tailwind 3 + generated `brand-tokens.css` (`npm run brand`) |
| State | Zustand |
| Auth / data | Firebase Auth, App Check, Firestore (feedback) |
| Markdown | DOMPurify-sanitized HTML |

Not in the tree: Vite, Framer Motion, Radix UI. Do not document them as current.

## Invariants

1. All HTTP goes through `frontend/src/services/api/`, aligned with `contracts/openapi.yaml`.
2. Views dispatch to Zustand; do not mutate remote state from random components.
3. Interactive controls need a name, `:focus-visible`, and working keyboard paths.
4. Tokens come from `brand-tokens.css` / Tailwind semantic classes. No one-off hex or `text-[11px]` in new UI.
5. Unfinished capabilities stay behind flags with honest copy, or they stay out of the UI.
6. `frontend/dist/` is generated. Never edit it by hand.
