# MindPal Comprehensive Security & Logic Audit Report

## 1. Architecture Overview
MindPal uses a **FastAPI** backend and a vanilla **JavaScript** frontend. Key architectural features include:
- **Tiered Prompting**: Messages are classified (Greeting, Casual, Emotional, Clinical, Crisis) to optimize system prompt size and LLM reasoning depth.
- **Adaptive Cortical Memory (ACM)**: A dual-layered memory system (V2 Legacy Summary + V3 Graph Atoms) with hard storage and prompt-injection limits.
- **Service-Oriented Design**: Clean separation between LLM, Safety, RAG, and DB services.

## 2. Security Vulnerabilities & Fixes

### 2.1. Fixed: Insecure Direct Object Reference (IDOR) in Debug Endpoint
**Vulnerability**: The `/api/chat/debug/{request_id}` endpoint allowed any authenticated user to view LLM traces (latency, provider, error codes) for any `request_id`, regardless of ownership.
**Fix**:
- Updated `ProviderChainTrace` schema to include `user_id_hash`.
- Modified `LLMService` to capture ownership from request metadata.
- Added an ownership check in `chat_router.py` to ensure users can only access their own traces.

### 2.2. Frontend: Potential XSS Risks
**Issue**: The frontend (`ui_state.js`, `dom.js`) uses `innerHTML` and manual HTML string concatenation for rendering LLM responses.
**Risk**: While `formatMarkdown` provides regex-based escaping, heuristic sanitization is prone to bypasses. If an attacker (or a compromised LLM) generates malicious HTML that evades the regexes, it could lead to script execution.
**Recommendation**: Transition to a more robust sanitization library (e.g., DOMPurify) or use DOM APIs (e.g., `textContent`, `createElement`) instead of raw string injection.

### 2.3. Firebase Configuration Exposure
**Issue**: Firebase API keys and project IDs are hardcoded in `index.html`.
**Risk**: While typical for client-side apps, it increases the reliance on correctly configured **Firebase Security Rules**. If Firestore rules are too permissive, attackers can read/write data directly using these keys.

## 3. Logic Problems & Glitches

### 3.1. Guest Mode Quota Bypass
**Issue**: Backend routers (`chat_router.py`, `chat_stream_router.py`) only increment and check quotas for authenticated users.
**Logic Problem**: Guest users (Local Mode) can use the service indefinitely, including the expensive "Pro" model, without any credit cost being enforced on the server.
**Recommendation**: Implement IP-based rate limiting or local storage-based usage tracking for guest sessions on the backend.

### 3.2. Post-Execution Charging (Race Condition)
**Issue**: Message credits are deducted *after* LLM generation finishes.
**Logic Problem**: A user near their limit could fire multiple concurrent requests. Since the quota is only updated at the end of each request, they might "overdraft" their account before the system blocks them.

### 3.3. Memory "Fullness" & Compaction
**Issue**: Users reporting "memory too full" are likely hitting hard caps:
- **Compacted Summary**: 4,000 characters.
- **System Prompt Injection**: 2,500 characters.
**Logic Problem**: When memory exceeds these limits, the system (during compaction) must choose what to drop. If the compaction LLM is not aggressive enough, the memory becomes stagnant or over-saturated.

## 4. Deep Analysis Conclusion
MindPal is built with a strong "safety-first" philosophy, evidenced by the tiered prompting and robust PII redaction. The most significant risks are the **Guest Mode Quota Bypass** (resource exhaustion) and the **Frontend XSS surface** (manual HTML building). The IDOR vulnerability in the debug endpoint has been successfully mitigated as part of this audit.
