# backend/services/domain/llm/prompts/__init__.py

"""
LLM Prompt engineering & assembly package.
Contains structured prompt builders, template loaders, and static prompt definitions.
"""

from __future__ import annotations

from .prompt_builder import build_tiered_prompt, get_self_knowledge_response
from .prompt_loader import (
    clear_prompt_cache,
    get_channel_instructions,
    get_clinical_pro_data,
    get_clinical_pro_text,
    get_identity_data,
    get_locale_instructions,
    get_locale_rules_data,
    get_product_boundaries_text,
    get_response_mode_instructions,
    get_response_modes_data,
    get_safety_level_instructions,
    get_safety_rules_data,
    get_safety_style_text,
    get_standard_chain_data,
    get_standard_chain_text,
    get_wellness_assistant_text,
    load_template,
)
from .prompts import (
    CLINICAL_PRO_PROMPT,
    PRODUCT_BOUNDARY_PROMPT,
    SAFETY_STYLE_PROMPT,
    VALID_RAG_TAGS,
    WELLNESS_ASSISTANT_PROMPT,
    Channel,
    PromptPolicy,
    ResponseMode,
    build_intent_context,
    build_system_prompt,
    infer_response_mode,
    infer_response_mode_for_preference,
)

__all__ = [
    "CLINICAL_PRO_PROMPT",
    "PRODUCT_BOUNDARY_PROMPT",
    "SAFETY_STYLE_PROMPT",
    "VALID_RAG_TAGS",
    "WELLNESS_ASSISTANT_PROMPT",
    "Channel",
    "PromptPolicy",
    "ResponseMode",
    "build_intent_context",
    "build_system_prompt",
    "build_tiered_prompt",
    "clear_prompt_cache",
    "get_channel_instructions",
    "get_clinical_pro_data",
    "get_clinical_pro_text",
    "get_identity_data",
    "get_locale_instructions",
    "get_locale_rules_data",
    "get_product_boundaries_text",
    "get_response_mode_instructions",
    "get_response_modes_data",
    "get_safety_level_instructions",
    "get_safety_rules_data",
    "get_safety_style_text",
    "get_self_knowledge_response",
    "get_standard_chain_data",
    "get_standard_chain_text",
    "get_wellness_assistant_text",
    "infer_response_mode",
    "infer_response_mode_for_preference",
    "load_template",
]
