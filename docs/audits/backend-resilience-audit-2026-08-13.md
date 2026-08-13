# MindPal Backend Resilience Audit

**Author:** Manus AI  
**Audit date:** 2026-08-13  
**Scope:** MindPal backend architecture, authorization boundaries, deterministic safety routing, output safety, RAG trust boundaries, multilingual handling, bounded local load, static analysis, and production dependency vulnerability checks.

## Executive summary

MindPal has a substantially stronger backend foundation than a typical chat application. It separates request authentication, rate limiting, quota reservation, durable memory, safety routing, tool execution, and provider access. It also uses local deterministic safety rules before optional model-assisted classification, and it validates generated assistant output before it is returned. These are appropriate defense-in-depth controls for a wellness-oriented product.[1]

This audit added a focused adversarial regression suite and fixed four concrete issues: an outdated verification script that could not run against the repository’s current documentation layout, two vulnerable Python transitive dependencies, stale Node production dependency resolutions, and an output-safety pattern that missed a common unsafe phrase shape. The audit also added explicit untrusted-data framing and control-marker neutralization to English RAG context, including Base64-obfuscated control instructions. The resulting full verification pipeline passes with **86 Python tests**, **11 Node tests**, **22 adversarial resilience tests**, clean Ruff and Bandit scans, and zero known production dependency vulnerabilities.

> The load testing was deliberately run **in-process against the test ASGI application**, not against Vercel or external providers. It validates local concurrency, rate-limit correctness, request middleware, and routing behavior without causing production traffic or third-party model costs.

| Audit area | Outcome | Evidence |
|---|---|---|
| Existing regression baseline | Passed | 64 Python tests before new coverage |
| New adversarial suite | Passed | 22 tests covering prompt injection, language, output safety, SSRF, redaction, rate limits, concurrency, and ASGI load |
| Controlled load | Passed | 1,000 `/api/health` requests, bounded at 100 concurrent in the in-process ASGI harness |
| Rate-limit atomicity | Passed | 250 simultaneous consume attempts admitted exactly 73 requests |
| Concurrency guard | Passed | 64 work items never exceeded a configured concurrency of 4 |
| Production configuration | Passed | OpenAPI smoke test resolved 34 routes with production docs endpoints disabled |
| Static analysis | Passed | Ruff and Bandit completed without findings |
| Python dependency audit | Fixed and passed | `cryptography` and `h2` upgraded; `pip-audit` reports no known vulnerabilities |
| Node dependency audit | Fixed and passed | Lockfile refreshed; `npm audit --omit=dev --audit-level=high` reports zero vulnerabilities |

## Backend workflow observed

MindPal processes a user turn through a layered request path. Request validation and session resolution establish the user context. Deterministic safety classification evaluates the input before model generation; an imminent risk match bypasses the model and routes to a deterministic crisis response. For non-bypass paths, the system can load relevant memory, RAG grounding, profile preferences, and narrowly scoped tools. A provider response is processed by a post-generation output guard before being persisted or returned. Rate limits, quota reservations, idempotency, and request IDs protect service capacity and replay behavior across these paths.

| Layer | Existing control | Audit assessment |
|---|---|---|
| Request boundary | Body-size limits, typed Pydantic models, request IDs, trusted host/CORS settings | Covered by existing production configuration and request-limit tests |
| Identity and authorization | Authenticated context dependencies for user, memory, chat store, and tool routes | Route inventory confirms user-scoped operations derive identity from request context, not caller-provided IDs |
| Resource controls | Distributed fixed-window rate limits, local per-worker concurrency limits, quota reservations, idempotency | New high-contention tests prove exact admission limits and concurrency caps locally |
| Input safety | Deterministic English and Arabic rule sets before optional LLM ambiguity classification | New injection-wrapper tests prove an adversarial prefix does not weaken imminent deterministic routing |
| Model boundary | Structured prompt assembly with safety sections and scoped tool instructions | RAG hardening now treats English retrieved content as explicitly untrusted reference data |
| Output safety | Deterministic prohibited-output guard, critical-category blocking, optional rewrite and re-scan | New tests uncovered and fixed a phrase-match gap; unsafe rewrites now have regression coverage |
| Data leakage controls | Log redaction helpers and URL validation with private-address rejection | New tests verify common PII/secret masking and private/unsafe URL rejection |

## Findings and fixes

### F-01 — Backend verification was blocked by stale release-file references

The repository verification script required root-level release documents that no longer exist: `.env.production.example`, `BACKEND_V2_ARCHITECTURE.md`, and `DEPLOY_BACKEND_V2.md`. The maintained project uses `.env.example`, `docs/architecture/system-overview.md`, and `docs/ops/release-and-deploy-flow.md`. As a result, `python scripts/verify_backend_v2.py` terminated before running its actual checks.

**Fix:** Updated the required-file gate in `scripts/verify_backend_v2.py` to reference maintained files. The complete pipeline now runs through tests, static analysis, frontend checks, production configuration smoke tests, and dependency audits.

### F-02 — Audited production dependencies had known vulnerabilities

The initial production audits reported two Python issues and three Node issues in the resolved dependency set. The Python lock pinned `cryptography==49.0.0` and `h2==4.3.0`; the Node lock resolved vulnerable ranges for DOMPurify, NanoID, and PostCSS.

**Fix:** Regenerated the Python lock with `cryptography==50.0.0` and `h2==4.4.1`; refreshed `package-lock.json` using the package manager’s security remediation. The frontend bundle and immutable manifest were rebuilt after the lockfile change. `pip-audit -r requirements.lock` and `npm audit --omit=dev --audit-level=high` now report no known production vulnerabilities.

### F-03 — English retrieved RAG context was not explicitly treated as untrusted data

Before remediation, English RAG grounding passed through unchanged into the assembled system prompt. Curated data is useful, but retrieved content is still a trust-boundary concern: a malicious or poisoned record could include natural-language control instructions. OWASP identifies direct and indirect prompt injection, untrusted external content, encoded payloads, and multilingual/obfuscated variants as relevant application risks.[1] [2]

**Fix:** `backend/core/prompt_builder.py` now wraps English RAG material in a clear reference-data delimiter, instructs the model not to execute embedded instructions, caps the material, neutralizes common direct control markers, and removes safely decoded Base64 control instructions. Non-English RAG behavior already reduces raw English content to technique labels. New tests cover direct and Base64-obfuscated instruction markers.

**Boundary:** This is a defense-in-depth layer, not a proof that natural-language prompt injection is impossible. Retrieved sources must remain curated, versioned, minimally privileged, and continuously evaluated.[1] [3]

### F-04 — Critical output guard missed a common unsafe phrase form

The post-generation output guard correctly uses deterministic `block_and_fallback` handling for critical categories. However, its English self-harm-instruction pattern did not match the common form “Here is how to harm yourself,” which the new adversarial regression exposed. The response was therefore incorrectly allowed by the local guard.

**Fix:** Broadened the pattern in `backend/safety/prohibited_outputs.yaml` to cover `here is how to`, `here’s how to`, `how to`, `steps to`, and `the best way to` variants. English and Arabic critical-output tests now assert deterministic blocking. A rewrite-rescan test also verifies that an unsafe output from the optional rewrite model falls back rather than escaping the guard.

## Adversarial test matrix

The new suite is located at `tests/test_backend_adversarial_resilience.py`. It uses only local fixtures, in-memory persistence, and the test ASGI app. It does not invoke paid model providers or target the deployed service.

| Test category | Cases covered | Expected security property |
|---|---|---|
| Direct jailbreak wrappers | English, Arabic, and mixed-language control prefixes around an imminent-risk input | Deterministic safety level remains `self_harm_imminent`; model path is bypassed |
| Safety classifier downgrade resistance | Fake LLM classifier installed on an imminent input | The LLM classifier is never called after a local imminent match |
| English RAG injection | Direct control markers in RAG | The output is data-delimited and control text is neutralized |
| Base64 RAG injection | Decodable control text embedded in Base64 | Encoded instruction is removed before prompt insertion |
| Non-English RAG isolation | Arabic-language path with malicious body content | Only technique labels survive; raw instruction body is excluded |
| Locale handling | English, Arabic, invalid and empty locale values | Locale normalization is bounded and deterministic |
| Output guard | English and Arabic critical unsafe phrase shapes | Original output is blocked and replaced with a safe fallback |
| Rewrite safety | Unsafe rewrite returned by a mocked provider | Rewrite is re-scanned and deterministically falls back |
| PII and secret redaction | Email, phone, IPv4, bearer-like secret | Sensitive text is not retained in redacted output |
| SSRF guard | Loopback, link-local metadata endpoint, localhost, `file://` | URL validator rejects unsafe request targets |
| Rate-limit contention | 250 simultaneous requests under a 73-request limit | Exactly 73 requests are admitted |
| Concurrency gate | 64 work items under a limit of 4 | Peak active work never exceeds 4 and slots are released |
| ASGI load | 1,000 health checks, bounded at 100 concurrent | Every request is `200`, has `no-store`, and preserves request ID integrity |

## Validation commands and final results

```bash
python3 scripts/verify_backend_v2.py --online-audit
python3 -m pytest tests/test_backend_adversarial_resilience.py -q
```

The end-to-end verifier completed successfully after the fixes. It compiled source files, ran all Python tests, ran frontend tests, completed Ruff and Bandit scans, rebuilt and checked production frontend artifacts, audited frontend delivery invariants, validated production OpenAPI configuration, and completed both Node and Python dependency audits.

| Validation | Final result |
|---|---|
| Python full suite | **86 passed**, 1 third-party deprecation warning |
| Adversarial resilience suite | **22 passed** |
| JavaScript suite | **11 passed** |
| Ruff | Passed |
| Bandit | Passed |
| Backend verifier with `--online-audit` | Passed |
| `pip-audit` | No known vulnerabilities |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| Prebuilt frontend verification | Passed after rebuilding artifacts |

## Remaining operational recommendations

The current repository tests local behavior well, but production readiness benefits from a staged environment that uses non-production credentials and synthetic accounts. Run sustained endpoint testing only against that environment and set explicit provider spend ceilings, concurrency budgets, and alert thresholds. OWASP identifies resource limits, request throttling, payload bounds, and third-party spending controls as necessary controls against unrestricted resource consumption.[4]

Keep the newly added adversarial suite in continuous integration and expand it whenever a provider, tool, retrieval source, or language policy changes. Prompt injection cannot be solved by a single regular expression or system prompt; it requires the layered design already present in MindPal: constrained tool access, user-scoped authorization, trusted-source controls, deterministic safety paths, output validation, rate controls, and regular attack simulation.[1] [2] [3]

## References

[1]: https://genai.owasp.org/llmrisk/llm01-prompt-injection/ "OWASP LLM01:2025 Prompt Injection"
[2]: https://github.com/OWASP/www-project-ai-testing-guide/blob/main/Document/content/tests/AITG-APP-01_Testing_for_Prompt_Injection.md "OWASP AI Testing Guide: AITG-APP-01 Testing for Prompt Injection"
[3]: https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html "OWASP LLM Prompt Injection Prevention Cheat Sheet"
[4]: https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/ "OWASP API4:2023 Unrestricted Resource Consumption"
