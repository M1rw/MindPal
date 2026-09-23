# Backend Configuration Contract

MindPal backend runtime configuration is centralized under `backend/configs`.

## Ownership

- `backend/configs/settings.py`: typed environment-backed `Settings` model and the cached `get_settings()` entry point.
- `backend/configs/app.py`: application environment, trusted hosts, and CORS helpers.
- `backend/configs/auth.py`: non-secret Firebase browser bootstrap values.
- `backend/configs/storage.py`: durable storage provider selection and Supabase connection values.
- `backend/configs/llm.py`: OpenRouter and Groq defaults, credentials, URLs, and model selection.
- `backend/configs/prompts.py`: reusable chat and voice reaction prompts.
- `backend/configs/voice.py`: voice safety, support, and recap policy text.
- `backend/configs/json/memory_rules.json`: memory extraction thresholds, stop words, and pattern rules.
- `backend/configs/json/quota.json`: account and anonymous quota windows, limits, and costs.
- `backend/configs/json/voice_runtime.json`: voice session, classifier, reaction, recap, and token settings.
- `backend/configs/json/safety.json`: safety normalization, crisis response, and output-guard settings.
- `backend/configs/json/api_limits.json`: HTTP payload and request ceilings.
- `backend/configs/json/domain_limits.json`: grounding, memory graph, wellness, and release limits.
- `backend/configs/json/wellness_rules.json`: wellness sentiment, theme, and event vocabularies.
- `backend/configs/json/behavior.json`: chat, flags, memory, recall, and storage behavior values.
- `backend/configs/json/voice_tools.json`: Live voice tool descriptions and safety-facing tool guidance.
- `backend/configs/runtime.py`: shared JSON configuration loader.
- `backend/configs/memory.py`: typed loading and regex compilation for memory rules.
- `backend/configs/rules.py`: reusable domain policy rules.

## Runtime Rules

1. Feature, domain, and infrastructure modules consume `get_settings()` or a helper in `backend.configs`.
2. New code must not call `os.environ` directly.
3. Secrets use `SecretStr` and must never be included in browser bootstrap payloads or logs.
4. `get_settings()` is the single access point and reads the current validated environment snapshot. Tests can change environment variables between calls without touching production modules.
5. `.env` and `.env.local` are loaded by `pydantic-settings`; the application entrypoint does not implement a second dotenv parser.
6. Prompt text and safety policy belong in config modules, while domain modules keep orchestration and behavior.

## Storage Provider Precedence

The selected storage provider is resolved in this order:

1. `MINDPAL_STORAGE_PROVIDER`
2. `supabase`

Firestore is disabled for application runtime. Selecting it explicitly fails startup; the Firestore adapter remains only for isolated legacy unit coverage.

Supabase requires both `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. The service-role key is server-only.

## Adding Configuration

When adding a setting:

1. Add a typed field and environment alias to `backend/configs/settings.py`.
2. Add a small domain-specific helper only when it expresses real precedence or validation.
3. Import that helper from the consuming module.
4. Add a focused test for defaults, precedence, and secret handling where relevant.
5. Update `.env.example` and deployment documentation when the variable is operator-facing.
