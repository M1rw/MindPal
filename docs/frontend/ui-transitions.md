# UI Transitions & Animations

## Welcome → Chat Transition

When the user sends their first message, the welcome screen transitions smoothly to the chat view.

### How It Works

**CSS** (`frontend/css/style.css`):
```css
#welcome-screen {
  transition: opacity 0.4s ease, transform 0.4s ease;
}
#welcome-screen.fade-out {
  opacity: 0;
  transform: translateY(20px);
  pointer-events: none;
}
```

**JS** (`frontend/js/ui_state.js` → `setChatStarted()`):
1. Adds `.fade-out` class to `#welcome-screen`
2. After 400ms (matching CSS transition duration):
   - Hides welcome screen (`hidden` class)
   - Removes `.fade-out`
   - Shows chat history
   - Uses **FLIP animation** to smoothly glide the input bar from its centered position to the bottom
3. FLIP captures the input's Y position before layout swap, applies the layout change instantly, then animates from old to new position using `translateY` with a 450ms cubic-bezier easing

### Layout States

| State | interaction-area classes | Input position |
|-------|------------------------|----------------|
| Welcome (default) | `flex-1 justify-center` | Centered with greeting |
| Chat active | `flex-none justify-end pt-0` | Bottom of screen |

### Restoring Welcome State

When clearing chat or resetting, `setChatStarted(false)` restores the welcome screen instantly (no animation on restore).

---

## Loading Screen

The loading screen (`#global-loader`) shows a typewriter animation with gradient text:

- **Phrases**: `['Hello.', 'Getting things ready…', 'Almost there…']`
- **Typing speed**: 70ms per character
- **Pause between phrases**: 1800ms
- **Fade transition**: 400ms opacity fade between phrases
- **Text sizes**: Responsive — `text-3xl` (mobile) → `text-4xl` (sm) → `text-5xl` (md+)

### Removal
The loading screen is removed by `app.js` bootstrap or by a 12-second safety timeout if bootstrap fails.

---

## Thought Accordion (Claude-style)

AI responses from the Pro model show a "Thought for X.Xs" accordion:
- **While streaming**: Shows "Thinking…" with a shimmer animation
- **When complete**: Shows "Thought for X.Xs" with the actual duration
- **On click**: Expands to show a concise summary of the reasoning chain
- **Copy behavior**: The copy button copies only the visible response, not the thought chain
