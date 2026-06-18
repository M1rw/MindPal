# Safety System — Crisis Detection & Response Routing

## Overview

MindPal's safety system is the first gate every message passes through. It classifies risk level and can override the user's chosen mode with a safety-specific response.

## Safety Classification Pipeline

```mermaid
flowchart TD
    MSG["User Message"] --> CLASSIFY["Safety Classifier"]
    
    CLASSIFY --> SAFE["✅ SAFE<br/>Normal processing"]
    CLASSIFY --> PANIC["🟡 PANIC<br/>Acute anxiety/panic"]
    CLASSIFY --> SELF_HARM["🔴 SELF-HARM AMBIGUITY<br/>Possible self-harm reference"]
    CLASSIFY --> DANGER["🔴 IMMEDIATE DANGER<br/>Active crisis"]
    CLASSIFY --> ANGER["🟡 ANGER IMPULSE<br/>Aggressive emotional state"]
    
    SAFE --> NORMAL["Normal chat pipeline"]
    PANIC --> GROUNDING["Panic grounding response<br/>(RAG: breathing, 5-4-3-2-1)"]
    SELF_HARM --> SUPPORT["Ambiguous self-harm support<br/>(Careful, no assumptions)"]
    DANGER --> CRISIS["Crisis response<br/>(Hotlines, emergency contacts)"]
    ANGER --> DEESCALATE["Anger de-escalation<br/>(Validate, redirect)"]

    style DANGER fill:#ea4335,color:white
    style SELF_HARM fill:#ea4335,color:white
    style PANIC fill:#fbbc04,color:black
    style ANGER fill:#fbbc04,color:black
    style SAFE fill:#34a853,color:white
```

## Safety Override Rules

Safety classification **always overrides** the user's selected mode:

```mermaid
flowchart LR
    MODE["User's Mode<br/>(Active Listen / Guided Coach / Cognitive Tools)"]
    SAFETY["Safety Result"]
    
    MODE --> DECIDE{"Safety flag?"}
    SAFETY --> DECIDE
    
    DECIDE -->|"No flag"| USE_MODE["Use user's mode"]
    DECIDE -->|"Flag raised"| USE_SAFETY["Override with safety mode"]
    
    style USE_SAFETY fill:#ea4335,color:white
```

## Response Modes (Backend)

| Mode | Trigger | Behavior |
|------|---------|----------|
| `normal_support` | No safety flag | Use user's selected mode |
| `panic_grounding` | Panic/acute anxiety detected | 5-4-3-2-1 grounding, box breathing |
| `ambiguous_self_harm_support` | Possible self-harm language | Careful inquiry, no assumptions |
| `personal_safety` | Active danger | Crisis resources, hotlines |
| `anger_deescalation` | Aggressive emotional state | Validate anger, redirect energy |
| `study_stress` | Academic overwhelm | Structured study strategies |
| `relationship_distress` | Partner/relationship issues | Name pattern, one safety question |
| `emotion_labeling` | Vague emotional state | Help identify and name emotions |

## Product Boundaries

MindPal stays focused on emotional support. The `PRODUCT_BOUNDARY_PROMPT` enforces:

```mermaid
graph LR
    subgraph "✅ MindPal Will Help With"
        A["Emotional support"]
        B["Anxiety & stress"]
        C["Relationship advice"]
        D["Sleep & wellness"]
        E["CBT/DBT techniques"]
        F["Grounding exercises"]
    end

    subgraph "❌ MindPal Will Decline"
        G["Coding / math"]
        H["General knowledge"]
        I["Creative writing"]
        J["Medical diagnosis"]
        K["Legal advice"]
        L["Off-topic chat"]
    end
```

When off-topic requests are detected, MindPal responds:
> "I'm designed to support your emotional well-being. I'm not the best fit for [topic], but I'm here if you'd like to talk about how you're feeling."

## Safety Disclaimers

Injected into every response context:
- Never diagnose or prescribe
- Never claim to replace professional care
- Always recommend professional help for serious concerns
- Clinical frameworks are guidance, not treatment
- AI may make mistakes — always consult a licensed professional

## Clinical Extraction

After each conversation, the `clinical_extractor.py` service extracts:
- **PHQ-9 signals** (depression screening indicators)
- **GAD-7 signals** (anxiety screening indicators)
- **Observed patterns** (sleep, appetite, energy, concentration)

These are displayed in the Mental Health tab of the Settings panel as clinical insights, NOT as diagnoses.
