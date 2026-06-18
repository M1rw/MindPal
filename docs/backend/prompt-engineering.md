# Prompt Engineering — Safety, Memory & Response Quality

## System Prompt Architecture

The system prompt is constructed by `backend/core/prompts.py` → `render_system_prompt()`. It assembles sections dynamically based on the current model, mode, language, and safety state.

### Prompt Structure

```
┌──────────────────────────────────────┐
│ BASE PERSONA                          │  ← Core identity, tone, ethics
├──────────────────────────────────────┤
│ MODE-SPECIFIC BLOCK                   │  ← Active Listen / Guided Coach / Cognitive Tools
├──────────────────────────────────────┤
│ SAFETY_STYLE_PROMPT                   │  ← Clinical safety guidelines
├──────────────────────────────────────┤
│ PRODUCT_BOUNDARY_PROMPT               │  ← Scope enforcement (stay on-topic)
├──────────────────────────────────────┤
│ MEMORY CONTEXT                        │  ← User's durable memory (with staleness warning)
├──────────────────────────────────────┤
│ THOUGHT CHAIN GUIDELINES (Pro)        │  ← How to structure internal reasoning
├──────────────────────────────────────┤
│ LANGUAGE DIRECTIVE                    │  ← Auto-detected or explicit language instructions
└──────────────────────────────────────┘
```

## Key Safety Prompts

### SAFETY_STYLE_PROMPT
Injected into ALL modes (including Pro clinical mode):
- Never diagnose, prescribe, or claim to replace professional care
- Always recommend professional help for serious concerns
- Use evidence-based frameworks as guidance, not treatment
- Maintain emotional safety throughout conversations

### PRODUCT_BOUNDARY_PROMPT
Keeps MindPal focused on its purpose:
- Declines off-topic requests (coding, math, general knowledge)
- Gently redirects to mental health / emotional support topics
- Does not generate creative fiction, code, or technical content
- Responds with: "I'm designed to support your emotional well-being..."

## Memory Integration

### Staleness Warning
Memory context includes a freshness indicator:
```
⚠️ This memory may be outdated. Verify key facts with the user
if the conversation contradicts stored information.
```

### Memory Structure in Prompt
```
You know the following about this user:
- Name: [preferred_name]
- Key people: [relationships]
- Emotional patterns: [triggers, coping strategies]
- Goals: [user goals]
- Preferences: [communication style, avoided topics]
```

## Thought Chain (Pro Model)

### Guidelines Injected
- Maximum ~200 words for Standard, unlimited for Pro
- Must maintain continuity — reference prior reasoning
- **Core Belief label** used instead of "Thought:" to avoid parser collision
- Self-review step at the end of the chain

### Frontend Label Mapping
The `chat_helpers.js` parser recognizes:
```javascript
labelPattern: /\*\*(emotion|insight|reflection|core belief|...\*\*)/i
```
`"core belief"` was added to prevent collision with the thought accordion's `**Thought:**` label.

## Language Handling

- Auto-detected from user input
- Arabic input → Arabic response (unless user requests otherwise)
- Mixed language → follows the dominant language of the message
- Language directive is the LAST section in the prompt (highest priority)

## Response Quality Rules

1. **No repetitive openers** — avoid starting every response with "I hear you" / "That sounds..."
2. **Vary acknowledgment patterns** — mix direct, reflective, and action-oriented responses
3. **Natural conversation flow** — respond as a caring friend, not a script
4. **Progressive depth** — short responses for simple check-ins, deeper for complex issues
5. **Don't over-validate** — balance empathy with gentle challenges when appropriate
