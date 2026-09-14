# Safety & Crisis Audit (Backend)

## Executive Summary & Findings

A comprehensive code audit was conducted across the backend codebase (`backend/services/domain/safety/`, `backend/safety/`, `backend/models/safety.py`, and `backend/api/routers/safety.py`) to evaluate crisis detection, deterministic escalation, severity mapping, and safety guardrails.

---

## Safety Evaluation Architecture

1. **Rule Engine & Pattern Matching**:
   - Local regex pattern matching is implemented in `backend/services/domain/safety/pattern_matcher.py`.
   - YAML rules are loaded from `crisis_patterns_en.yaml` and `crisis_patterns_ar.yaml`.
   - Deterministic keyword matching covers explicit suicidal ideation and self-harm terms in English and Arabic.

2. **Classification Levels**:
   - `SafetyLevel.SAFE`: Standard conversational processing.
   - `SafetyLevel.SELF_HARM_AMBIGUOUS`: Flagged for supportive framing; sent to LLM with safe bounds.
   - `SafetyLevel.SELF_HARM_IMMINENT`: **Bypasses LLM generation completely**. Returns a deterministic, pre-rendered localized crisis response containing emergency helplines (988 in the US, regional hotlines in Arabic).

3. **External Integration Guardrails**:
   - **TTS Integration**: In `backend/api/routers/tts.py`, external audio synthesis is automatically disabled when `safety_level == "self_harm_imminent"`.
   - **Voice Preview (v4)**: In `backend/features/voice/service.py`, voice streaming sessions are immediately blocked if a crisis condition is detected.

---

## Audit Checklist & Identified Gaps

| Checkpoint | Implementation Status | Findings & Evidence |
|---|---|---|
| Local Crisis Regex Engine | ✅ Implemented | Matched against localized YAML rules (`crisis_patterns_*.yaml`). |
| Deterministic LLM Bypass | ✅ Implemented | `SELF_HARM_IMMINENT` bypasses LLM call (`backend/models/safety.py:114`). |
| Multi-lingual Hotline Support | ✅ Implemented | Pre-rendered templates for `en` and `ar` in `crisis_responses.yaml`. |
| Active Telemetry Escalation / Webhooks | ⚠️ **Gap Confirmed** | No active webhook dispatch, SMS alert, or external escalation callback exists to notify clinical operators or system administrators upon imminent crisis trigger. Logged locally via sanitized events only. |
| Escalation Severity Escalation Tracking | ⚠️ **Gap Confirmed** | Repeated crisis messages within a single chat session do not increment session-level escalation thresholds; each message is evaluated independently without session risk escalation. |
