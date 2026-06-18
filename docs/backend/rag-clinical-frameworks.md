# RAG — Clinical Framework Grounding

## Overview

MindPal uses Retrieval-Augmented Generation (RAG) to ground AI responses in evidence-based clinical frameworks. This ensures responses follow established therapeutic techniques rather than relying solely on LLM "vibes."

## RAG Architecture

```mermaid
flowchart TD
    MSG["User Message"] --> INTAKE["Semantic Intake"]
    INTAKE --> TOPIC["Topic Classification"]
    
    TOPIC --> RETRIEVE["RAG Retrieval Engine"]
    
    subgraph "Corpus Sources"
        CORE["backend/rag/corpus/<br/>Core response frameworks"]
        CLINICAL["data/clinical_frameworks/<br/>CBT, DBT, grounding techniques"]
    end
    
    CORE --> RETRIEVE
    CLINICAL --> RETRIEVE
    
    RETRIEVE --> SCORE["Relevance Scoring"]
    SCORE --> TOP_K["Top-K Documents"]
    TOP_K --> PROMPT["Injected into System Prompt"]
    PROMPT --> LLM["LLM Generation"]

    style RETRIEVE fill:#34a853,color:white
    style LLM fill:#9b72cb,color:white
```

## Corpus Structure

### Core Corpus (`backend/rag/corpus/`)
Response framework templates for common scenarios:
- Panic attacks → Grounding sequences (5-4-3-2-1)
- Anxiety → Box breathing, cognitive restructuring
- Anger → De-escalation, emotion naming
- Study stress → Pomodoro, prioritization
- Relationship distress → Pattern naming, safety questions

### Clinical Frameworks (`data/clinical_frameworks/`)
Evidence-based therapeutic technique YAML files:
- **CBT** (Cognitive Behavioral Therapy) — thought records, cognitive distortions
- **DBT** (Dialectical Behavior Therapy) — distress tolerance, emotion regulation
- **Grounding** — sensory awareness, breathing exercises
- **Behavioral Activation** — activity scheduling, pleasure/mastery tracking

## Retrieval Flow

```mermaid
sequenceDiagram
    participant Pipeline
    participant RAGService
    participant Corpus
    participant Scorer

    Pipeline->>RAGService: retrieve(topic, context)
    RAGService->>Corpus: Load candidate documents
    Corpus-->>RAGService: Matching YAML units
    RAGService->>Scorer: Score relevance
    Scorer-->>RAGService: Ranked results
    RAGService-->>Pipeline: Top-K grounding context
    
    Note over Pipeline: Grounding context injected<br/>between mode block and<br/>memory context in prompt
```

## What RAG Is NOT

| RAG Is | RAG Is NOT |
|--------|-----------|
| Technique guidance | User-specific memory |
| Curated clinical content | LLM-generated advice |
| Evidence-based frameworks | Diagnosis or treatment |
| Deterministic retrieval | Hallucinated techniques |

## Health Endpoint

`GET /api/rag/health` — Verifies corpus is loaded and retrieval is functional.
