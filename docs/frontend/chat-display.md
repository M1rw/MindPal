# Chat Message Display & Copy Behavior

## Message Rendering

### User Messages
- Right-aligned bubble with rounded corners (`rounded-[24px]`)
- Background: `bg-gemini-surface` / dark: `bg-gemini-darkSurface`
- Max width: 80%
- RTL-aware: `dir="auto"` for Arabic text

### AI Messages
- Left-aligned, full width (max `max-w-3xl`)
- No bubble — clean text layout
- Supports markdown rendering: **bold**, *italic*, lists, code blocks, etc.
- Code blocks include syntax highlighting and language labels

### Thought Accordion (Pro Model)
```
┌─────────────────────────────────────┐
│ ⚡ Thought for 2.3s          ▼     │  ← Collapsed (default)
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ ⚡ Thought for 2.3s          ▲     │  ← Expanded
├─────────────────────────────────────┤
│ Concise summary of reasoning chain  │
│ - Key observations                   │
│ - Emotional patterns identified      │
│ - Approach selected                  │
└─────────────────────────────────────┘
```

**States**:
- **Streaming**: Shows "Thinking…" with shimmer animation
- **Complete**: Shows "Thought for X.Xs" with actual duration
- **Expanded**: Shows condensed reasoning summary

## Copy Button Behavior

The copy button on AI messages copies **only the visible response text**, not the internal thought chain.

**Implementation** (`frontend/js/utils/chat_helpers.js`):
- The copy function extracts text from the response container
- Thought accordion content is explicitly excluded from the copy selection
- Code blocks are copied with their content but without UI chrome (copy button, language label)

## Message Formatting

### Supported Markdown
- **Bold**, *italic*, ~~strikethrough~~
- Bullet lists and numbered lists
- Code blocks with language syntax highlighting: ` ```python ... ``` `
- Inline code: `` `code` ``
- Block quotes
- Links (opened in new tab)

### Structured Labels
The parser recognizes labeled sections in AI responses:
```
**Emotion:** Anxiety with underlying frustration
**Insight:** This pattern connects to...
**Core Belief:** You tend to...
**Reflection:** Consider that...
```

These are rendered with subtle formatting (colored labels, proper spacing).

## Streaming Behavior

1. User sends message → input disabled, "MindPal is responding..." placeholder
2. Status indicator appears (shimmer animation)
3. AI response streams in token-by-token
4. Markdown is rendered progressively
5. When stream completes → input re-enabled, status indicator removed
6. Chat auto-scrolls to bottom during streaming

## RTL / Bidirectional Text

- All text containers use `dir="auto"` for automatic direction detection
- Arabic text automatically right-aligns
- Mixed Arabic/English text follows the dominant language direction
