# Frontend Map & Page Inventory

## Overview

The MindPal frontend is built as a single-page web application (SPA) powered by native ES modules, Tailwind CSS, and DOM manipulation modules. Component templates in `frontend/components/` are assembled into `frontend/index.html` at build time.

---

## Page & View Inventory

| View / Modal | Component HTML | Primary JS Controller | Description & State Managed |
|---|---|---|---|
| **Main Chat Interface** | `frontend/components/chat/` | `frontend/js/app/main.js` | Main conversational interface; manages streaming chat responses, message history, voice call toggles, and response action buttons. |
| **Settings Modal** | `frontend/components/modals/profile_modal.html` | `frontend/js/ui/components/settings_ui.js` | Modular 12-tab settings panel (Voice, Personalization, Notifications, Appearance, Memory, Analytics, etc.). State managed via `settings_store.js`. |
| **Brain Workspace** | `frontend/components/modals/` | `frontend/js/ui/components/brain_workspace.js` | Dynamic memory graph visualization and interactive node browser. |
| **Neural Observatory** | `frontend/components/modals/` | `frontend/js/observability/neural_observatory.js` | Real-time AI reasoning, prompt inspection, and diagnostic latency metrics. |
| **Feature Admin UI** | `frontend/components/modals/` | `frontend/js/ui/components/feature_admin_ui.js` | Admin control panel for system feature toggles and rollout policies. |

---

## Client State Management Architecture

- **`frontend/js/state/app_state_model.js`**: Central application state container for active session data, message history, user profile, and global loading states.
- **`frontend/js/state/settings_store.js`**: Synchronizes local preferences (`localStorage`) with remote cloud profile preferences (`/api/user/profile`).
- **`frontend/js/state/feature_store.js`**: Maintains feature flag definitions and policy evaluations fetched from `/api/feature`.
- **`frontend/js/state/ui_state.js`**: Controls modal visibilities, toast notifications, and active tab states.

---

## Service Layer & API Clients

- **`frontend/js/services/api.js`**: Core HTTP client wrapper for backend API calls (`/api/chat`, `/api/user/*`, `/api/memory/*`, `/api/safety/*`).
- **`frontend/js/services/auth.js`**: Handles Firebase Auth and Google Identity Services (GSI) OAuth authentication.
- **`frontend/js/services/cloud_sync.js`**: Asynchronously syncs client state and local chat history with cloud storage.
