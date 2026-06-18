# Welcome Screen & Input Bar Layout

## Welcome Screen Structure

The welcome screen is the landing view when no chat is active.

### Components
1. **Gradient Greeting**: "Good evening, friend." — time-aware, personalized
2. **Subtitle**: "What's on your mind today?"
3. **Mood Quick-Start Buttons**: Three preset moods
4. **Input Bar**: Full-width text input with model selector and voice button
5. **Privacy Footer**: "MindPal guarantees privacy..."

### Layout

```
┌────────────────────────────────────────┐
│ MindPal  Local    🌙  1🔥  👤          │  ← Header (absolute, top)
│                                        │
│                                        │
│         Good evening, friend.          │  ← Centered greeting
│      What's on your mind today?        │
│                                        │
│  [I feel overwhelmed] [Anxious] [Stuck]│  ← Mood buttons
│                                        │
│  ┌──────────────────────────────────┐  │
│  │ Ask MindPal    Standard·Active ⌄ 🎙│  │  ← Input bar
│  └──────────────────────────────────┘  │
│  MindPal guarantees privacy...         │  ← Privacy text
└────────────────────────────────────────┘
```

### Centering
- `#interaction-area`: `flex-col flex-1 justify-center items-center`
- All children (greeting + input + privacy) center as one group
- `mb-10` on `#welcome-screen` creates spacing from the input bar

### Responsive Alignment
- `text-left sm:text-center` on `#welcome-screen`
- `justify-start sm:justify-center` on mood button container
- Below 640px: left-aligned (mobile feel)
- 640px+: centered (tablet/desktop feel)

## Greeting Logic

The greeting text is time-aware (`frontend/js/app.js`):
- Morning (5-12): "Good morning"
- Afternoon (12-17): "Good afternoon"
- Evening (17-21): "Good evening"
- Night (21-5): "Good night"

If the user has a saved name: "Good evening, [Name]."
Otherwise: "Good evening, friend."

## Mood Quick-Start Buttons

Three preset buttons inject a message and auto-send:

| Button | Icon | Injected message |
|--------|------|------------------|
| I feel overwhelmed | `waves` (blue) | "I'm feeling overwhelmed right now." |
| I'm feeling anxious | `wind` (purple) | "I'm feeling anxious right now." |
| I feel stuck | `anchor` (rose) | "I'm feeling stuck right now." |

**Behavior**: Clicking a mood button:
1. Sets `chat-input.value` to the mood message
2. Dispatches `input` event (triggers auto-resize)
3. Calls `handleSend()` (sends the message)

**Guards**: Disabled when `isSessionLocked` or `isGenerating`

## Input Bar

### Elements
- **Textarea**: Auto-resizing, max 200px height
- **Model/Mode Selector**: Shows "Standard · Active Listen"
- **Voice Button**: `audio-waveform` icon (was `mic`)
- **Send Button**: Appears when text is entered, hidden otherwise

### Voice Button
- Icon: `audio-waveform` (Lucide icon)
- Triggers voice recording on click
- During recording: pulses red with `recording-pulse` animation
- During generation: faded to 30% opacity, non-interactive

### Send Button
- Hidden by default
- Appears when input has text (`syncInputButtons()`)
- Disabled during generation
- Black circle with white up-arrow icon
