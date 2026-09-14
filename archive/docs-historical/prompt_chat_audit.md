# MindPal Prompt and Chat Quality Audit

**Author:** Manus AI  
**Scope:** Backend prompt construction, user-visible chat output, and regression validation  
**Status:** Implemented and locally validated

## Executive outcome

MindPal had a structural quality problem rather than a single weak sentence in its prompt. The standard `/api/chat` endpoint used an older, monolithic prompt builder while `/api/chat/stream` used a newer tiered builder. Both paths also contained instructions that could make the model emit a visible `Thought` block before answering. This combination can make responses feel robotic, overconfident, repetitive, or as if the user is being shown system internals rather than being spoken to naturally.

I implemented a unified **CLEAR response technique** and a deterministic output finalizer. CLEAR makes the desired user experience explicit: the assistant should capture the real request, lead with a direct acknowledgement or answer, explain only calibrated patterns, offer a small number of tailored actions, and re-engage only when a follow-up question is genuinely useful. The finalizer removes known legacy internal-reasoning wrappers before the safety gate and the user-visible response.

> **Important measurement boundary:** no credible engineering process can promise a literal “1000×” increase in human-perceived response quality from static prompts alone. The implementation eliminates a verified failure mode across all benchmarked prompt scenarios and adds objective quality contracts. A true quality multiplier requires an A/B test with real user ratings and safety review.

| Area | Before | After |
|---|---|---|
| Standard versus streaming behavior | `/api/chat` used the legacy builder; streaming used a different tiered builder | Both endpoints use `build_tiered_prompt` |
| Reasoning format | Legacy path required an outward `Thought` block; tier templates also instructed hidden-analysis labels | Private planning is permitted, but exposing thought, analysis labels, or internal protocol is forbidden |
| User-facing answer target | Broad and sometimes competing style instructions | CLEAR contract gives a direct, testable target for relevance, calibration, and actionability |
| Leak resilience | A provider could return legacy `Thought → Response` formatting unchanged | A deterministic finalizer extracts only the user-visible reply before the safety validator |
| Regression evidence | Prompt-marker checks only | Four-scenario before/after benchmark and eight focused response-quality tests |

## Root-cause findings

### 1. Endpoint divergence created unpredictable chat quality

The non-streaming route assembled its system prompt with the legacy `build_system_prompt` function, whereas the streaming route used `build_tiered_prompt`. The two builders had different formatting rules, prompt sizes, and thought-block requirements. Therefore, a user could receive materially different conversational quality depending on whether the UI chose streaming.

The fix moves `/api/chat` onto the same tiered prompting path as `/api/chat/stream`, including the same classifier-derived temperature and response-token settings. The semantic intake context and RAG grounding now use the same compact serialization strategy in both paths.

### 2. The prompt explicitly encouraged a user-visible internal-reasoning format

The legacy prompt directed the model to write a `**Thought:**` block first and then a user response. The tiered builder’s standard, emotional, and clinical chains similarly described `Thought`, `Response`, and `Balanced Reframe` labels. Even when a client intends to hide these blocks, providers can drift, fallbacks can change, and formatting instructions can leak to the response body.

The new private-planning contract retains the useful planning checks while instructing the model not to reveal chain-of-thought, hidden analysis, planning notes, scoring, or legacy labels. The user receives a natural answer only.

### 3. The old prompt did not make “useful, human” behavior operational

Phrases such as “be supportive” and “be specific” are too broad to reliably prevent generic wellness responses. They also do not provide a concise way to choose between reflection, explanation, next steps, and a question.

The revised design introduces **CLEAR**:

| Letter | Response behavior | Quality benefit |
|---|---|---|
| **C — Capture** | Identify the user’s actual request and stated emotion without inventing a motive, history, or diagnosis. | Prevents patronizing or fabricated personalization. |
| **L — Lead** | Start with a direct answer or concrete acknowledgement, not a generic reassurance. | Reduces filler and makes the response immediately useful. |
| **E — Explain** | Explain only a tentative, useful pattern; use calibrated language. | Avoids overclaiming and armchair diagnosis. |
| **A — Act** | Give one to three context-appropriate next steps. | Makes advice actionable without overwhelming the user. |
| **R — Re-engage** | Ask at most one easy question only when it improves the next reply. | Preserves conversation without turning every reply into an intake form. |

## Implemented changes

| File | Change |
|---|---|
| `backend/core/prompt_builder.py` | Replaced outward thought-block templates with private planning, added CLEAR, and applied it to greeting, casual, emotional, and clinical prompt tiers. |
| `backend/api/chat_router.py` | Migrated the standard endpoint from `build_system_prompt` to `build_tiered_prompt`; aligned classification, RAG formatting, token budget, and temperature with streaming. |
| `backend/api/chat_stream_router.py` | Applied the final user-visible response filter before output safety validation. |
| `backend/services/response_quality_service.py` | Added an idempotent finalizer for known legacy `Thought → Response`, `Balanced Reframe`, and XML internal-analysis wrappers. |
| `tests/test_response_quality_contract.py` | Added eight response-quality regression tests. |
| `scripts/evaluate_response_quality_contract.py` | Added a reproducible prompt-contract benchmark. |
| `tests/prompt_eval.py` | Updated the existing evaluation script to exercise the production tiered builder instead of the retired legacy builder. |

## Before-and-after evidence

The deterministic benchmark in [`response_quality_benchmark.md`](response_quality_benchmark.md) evaluates casual, emotional, clinical, and Egyptian Arabic support scenarios.

| Measured prompt contract | Baseline | Revised |
|---|---:|---:|
| Scenarios whose prompt required a visible thought block | 4/4 | 0/4 |
| Scenarios carrying the CLEAR response contract | 0/4 | 4/4 |
| Scenarios with an explicit private-reasoning guard | 0/4 | 4/4 |

A concrete wrapper-leak test also verifies the user-visible difference:

| Raw provider output | Final user-visible text |
|---|---|
| `**Thought:** private plan` followed by `**Response:** A grounded, user-visible response.` | `A grounded, user-visible response.` |

## Validation performed

The following focused regression command completed successfully:

```bash
pytest -q \
  tests/test_backend_adversarial_resilience.py \
  tests/test_api_feature_contracts.py \
  tests/test_chat_stream_replay.py \
  tests/test_response_quality_contract.py
```

**Result: 37 passed.** The updated legacy evaluation script also completed with no `FAIL` or traceback output. A Python syntax compilation check and whitespace-diff check completed successfully.

## Recommended production measurement

The implemented benchmark proves prompt and routing contracts, not subjective human preference. The next release should use a controlled rollout with an anonymous conversation-quality score after eligible chats. Compare the pre-change cohort with CLEAR on: first-response helpfulness, “felt understood” rating, follow-up usefulness, abandonment after the first assistant response, safety rewrite rate, and visible formatting-leak rate. Segment results by chat route, language, severity tier, and provider.

Do not optimize a raw “thumbs-up” metric alone. A meaningful safety-and-quality gate should require no regression in crisis handling or output-guard interventions while improving first-turn helpfulness and low-quality feedback. The existing request trace metadata can support route-, tier-, and provider-level analysis without storing raw private text in telemetry.

## How to reproduce

```bash
cd /path/to/MindPal
python3 scripts/evaluate_response_quality_contract.py
pytest -q tests/test_response_quality_contract.py
pytest -q tests/test_backend_adversarial_resilience.py tests/test_api_feature_contracts.py tests/test_chat_stream_replay.py
```

The benchmark is intentionally deterministic and does not call a paid external model. This makes it safe to run in continuous integration and prevents quality claims from depending on a transient provider response.
