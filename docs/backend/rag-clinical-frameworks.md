# RAG Clinical Frameworks

Purpose: make MindPal use controlled safe technique guidance instead of relying only on prompt instructions and model behavior.

Current corpus sources:

```txt
backend/rag/corpus
data/clinical_frameworks
```

`RAGService` loads YAML units from both locations. The original backend corpus remains supported. The clinical framework corpus adds focused units for high-frequency MindPal situations.

Core topics:

```txt
panic grounding
DBT STOP
5-4-3-2-1 grounding
cognitive reframe
anger delay
study triage
relationship boundary
relationship safety
```

Valid tags are controlled by `VALID_RAG_TAGS` in `backend/core/prompts.py`. New curated clinical units should use only those tags.

Current important tags:

```txt
panic_grounding
grounding_54321
box_breathing
orienting_to_room
anxiety
anger
impulse
dbt_stop
study_stress
exam_anxiety
relationship
relationship_distress
grief
emotion_labeling
cognitive_reframe
safety
self_harm
abuse_or_violence
sleep
breathing
journaling
```

YAML shape:

```yaml
schema_version: 1
domain: clinical_frameworks
units:
  - id: clinical_panic_grounding_54321
    category: anxiety
    technique: panic grounding with 5-4-3-2-1
    trigger_terms:
      - panic
      - panic attack
      - can't breathe
      - نوبة هلع
    instructions:
      - Start with one immediate sensory step, not an explanation.
      - Ask for 5 things the user can see, then pause.
    contraindications:
      - Do not claim the user is medically safe.
      - Do not present grounding as treatment.
    response_style:
      - short
      - calm
      - concrete
    tags:
      - panic_grounding
      - grounding_54321
      - anxiety
```

Health endpoint:

```txt
GET /api/rag/health
```

Expected fields:

```json
{
  "units_loaded": 58,
  "tags": ["anxiety", "panic_grounding", "relationship_distress"],
  "invalid_tags": [],
  "corpus_dirs": [".../backend/rag/corpus", ".../data/clinical_frameworks"],
  "loaded_files": ["..."],
  "failed_files": []
}
```

Notes:

```txt
loaded_units vs units_loaded:
  Current service field is units_loaded.
  If a frontend/debug panel needs loaded_units, add it as an alias without removing units_loaded.

invalid_tags:
  Existing legacy corpus may still contain older tags.
  New clinical framework units should stay aligned with VALID_RAG_TAGS.
```

Retrieval expectations:

```txt
"I am having a panic attack and cannot breathe"
  -> clinical_panic_grounding_54321

"I am furious and about to explode"
  -> clinical_dbt_stop_anger_delay

"I am overthinking everything and catastrophizing"
  -> clinical_cognitive_reframe_overthinking

"مش عارفة اكمل العلاقة هو بيقلل مني وبيتحكم فيا"
  -> clinical_relationship_boundary

"خايفة منه وبيهددني ومش سايبني اخرج"
  -> clinical_relationship_safety
```

Failure modes:

```txt
Malformed YAML:
  should appear in failed_files.

Duplicate unit id:
  should fail startup/reload because duplicate grounding ids create ambiguous retrieval.

Wrong tags:
  should appear in invalid_tags and fail tests for new clinical framework units.

Overbroad trigger terms:
  can cause unrelated queries to retrieve safety/relationship units.
```

