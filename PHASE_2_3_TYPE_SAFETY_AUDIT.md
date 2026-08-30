# Phase 2.3: Type Safety Audit & Migration Plan

**Date**: 2026-08-30  
**Task**: Upgrade to full type safety with Pydantic V2  
**Status**: IN PROGRESS  

---

## Current State Analysis

### Good News ✅
- Models are already using Pydantic V2 (ConfigDict, field_validator, model_validator)
- Most of the codebase is well-typed
- No issues with BaseModel definitions or validation

### Issues Found 📋

**Any Type Usage** (9 instances, 6 files):

1. **runtime_trace.py** (2 uses)
   - `clean_runtime_metadata(values: dict[str, Any] | None)`
   - Verdict: ✅ JUSTIFIED (unstructured metadata needs flexibility)
   - Improvement: Document with example

2. **_helpers.py** (3 uses)
   - `sanitize_ui_settings(value: object) -> dict[str, Any]`
   - `_sanitize_ui_setting_value(value: object, *, depth: int) -> Any`
   - Verdict: ✅ JUSTIFIED (UI settings are user-provided, unstructured)
   - Improvement: Use TypedDict or discriminated unions for known patterns

3. **memory.py** (3 uses)
   - `canonical_memory_key(category: str, value: str, metadata: dict[str, Any] | None = None)`
   - `_dedupe_brain_records(records: list[Any], limit: int) -> list[Any]`
   - Verdict: ⚠️ PARTIALLY JUSTIFIED
   - Improvement: Use TypeVar or Protocol for generic records

4. **voice_v4_layer0.py** (2 uses)
   - `build_safe_voice_diagnostic(payload: Mapping[str, Any] | None) -> dict[str, Any]`
   - Verdict: ✅ JUSTIFIED (diagnostic payloads are unstructured)
   - Improvement: Document with example

5. **user.py** (1 use)
   - `ui_settings: dict[str, Any] = Field(default_factory=dict)`
   - Verdict: ✅ JUSTIFIED (user settings are schemaless)
   - Improvement: Add validation hint in docstring

6. **safety.py** (1 use)
   - `to_public_dict(self) -> dict[str, Any]`
   - Verdict: ⚠️ CAN IMPROVE
   - Improvement: Return Dict[str, Union[...]] with known types

---

## Pydantic V2 Migration Status

### Already Migrated ✅
- Using BaseModel from pydantic
- Using ConfigDict for model config
- Using field_validator
- Using model_validator
- Proper type hints in most places

### Ready to Enhance
1. Add discriminated unions for better type safety
2. Use @field_validator with validation_alias
3. Leverage custom validators for complex logic
4. Add Pydantic Field descriptions for API docs

---

## Action Plan

### Phase 2.3.1: Improve memory.py Records Handling (30 min)
- [ ] Replace `list[Any]` with `list[dict]` in `_dedupe_brain_records`
- [ ] Use TypeVar for generic handling
- [ ] Add documentation for expected record structure

### Phase 2.3.2: Enhance Diagnostic Payloads (20 min)
- [ ] Create Diagnostic data structure in voice_v4_layer0.py
- [ ] Replace `Mapping[str, Any]` with typed version
- [ ] Document required and optional fields

### Phase 2.3.3: Improve Safety Output Types (30 min)
- [ ] Update `to_public_dict()` return type
- [ ] Use Union of known field types
- [ ] Add validation for output structure

### Phase 2.3.4: Document Justified Any Usage (20 min)
- [ ] Add comments explaining why Any is necessary
- [ ] Link to related validation functions
- [ ] Document expected value patterns

### Phase 2.3.5: Add Type Checking CI (20 min)
- [ ] Create mypy config for project
- [ ] Run mypy on all models
- [ ] Add to pre-commit hooks

---

## Files to Modify

1. **backend/models/memory.py** - Type-safe record handling
2. **backend/models/voice_v4_layer0.py** - Structured diagnostics
3. **backend/models/safety.py** - Typed output dicts
4. **backend/models/_helpers.py** - Document UI settings schema
5. **backend/models/runtime_trace.py** - Document metadata format
6. **pyproject.toml** or **setup.py** - Add mypy configuration

---

## Expected Outcomes

After Phase 2.3:
- ✅ All justified `Any` types documented
- ✅ Improved type hints in memory and voice modules
- ✅ Better IDE autocomplete and type checking
- ✅ mypy passing on backend/models/
- ✅ Clear patterns for handling unstructured data
- ✅ Zero regressions to existing code

---

## Integration with Phase 2.4

Phase 2.4 (Config Externalization) will benefit from improved types:
- Config dataclasses will have proper type hints
- Validators will use typed hints
- Settings will be fully type-safe

---

## Next: Start Implementation

Ready to begin Phase 2.3.1 (Improve memory.py records)
