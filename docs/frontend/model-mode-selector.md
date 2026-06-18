# Model & Mode Selector

The unified model/mode selector lets users switch between AI models and conversation modes.

## Models

| Model | Key | Description | Quota |
|-------|-----|-------------|-------|
| **Standard** | `standard` | Fast, warm peer-support. Safety-first with low latency. | 1× credit |
| **Pro** | `pro` | Advanced clinical reasoning with 6-step agent chain. Deep pattern analysis, nervous system assessment, self-review. | 2× credit |

### Pro Confirmation Dialog
Switching to Pro shows a confirmation dialog:
- Warning: "This is an AI assistant, not a real doctor"
- Toggle: "I understand the risks" must be enabled
- Only after toggle → "Confirm Switch" button becomes active

## Modes

| Mode | Description |
|------|-------------|
| **Active Listen** | Empathetic, reflective listening. Default mode. |
| **Guided Coach** | Structured coaching with actionable steps. |
| **Cognitive Tools** | CBT/DBT techniques, thought records, behavioral activation. |

## Selector UI

- Located inside the input bar, right side
- Shows current state as `"Standard · Active Listen"`
- Dropdown opens above the input bar (bottom-anchored)
- Model options have info tooltips explaining each model

## Locking During Generation

**When MindPal is generating a response, the selector is locked:**

1. **Visual indicator**: The selector label fades to 40% opacity (`opacity-40`)
2. **Interaction blocked**: `pointer-events-none` prevents clicks
3. **JS guard**: `isGenerating()` check prevents opening the dropdown or changing model/mode even if pointer-events is bypassed

**Implementation** (`frontend/js/ui_state.js` → `setInputState()`):
```javascript
const unifiedBtn = document.getElementById("unified-selector-btn");
if (unifiedBtn) {
  unifiedBtn.classList.toggle("opacity-40", isDisabled);
  unifiedBtn.classList.toggle("pointer-events-none", isDisabled);
}
```

**Model selector** (`frontend/js/components/model_selector.js` → `bindUnifiedSelector()`):
```javascript
export function bindUnifiedSelector({ isSessionLocked, isGenerating } = {}) {
  // ...
  btn?.addEventListener("click", (e) => {
    if (isSessionLocked?.() || isGenerating?.()) return;
    // ...
  });
}
```

## Persistence

- Model: `localStorage.mindpal_selected_model`
- Mode: `localStorage.mindpal_selected_mode`
- Restored on page load

## Switch Indicator

When model or mode changes during a chat, a visual divider appears in the chat history:
```
────── Model switched to Pro ──────
```
