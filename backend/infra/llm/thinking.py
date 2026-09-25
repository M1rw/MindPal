"""How much a Gemini model thinks, in the form that model generation accepts.

Gemini 2.5 takes a token budget; Gemini 3 refuses a budget (400 INVALID_ARGUMENT)
and takes a level instead. Callers state a budget; this translates it.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

logger = logging.getLogger("mindpal.llm")


def thinking_kwargs(model: str, budget: Optional[int]) -> Dict[str, Any]:
    """GenerateContentConfig kwargs for this model and budget ({} = provider default)."""
    if budget is None:
        return {}
    try:
        from google.genai import types
    except Exception:  # pragma: no cover - no SDK
        return {}
    try:
        if (model or "").startswith("gemini-3"):
            # "minimal" (no thinking) exists only on the Flash-Lite models; the
            # others refuse it with a 400, so their floor is "low".
            floor = "minimal" if "flash-lite" in model else "low"
            level = floor if int(budget) <= 0 else ("low" if int(budget) <= 2048 else "high")
            return {"thinking_config": types.ThinkingConfig(thinking_level=level)}
        return {"thinking_config": types.ThinkingConfig(thinking_budget=int(budget))}
    except Exception:  # pragma: no cover - SDK without these fields
        logger.info("llm_thinking_config_unsupported model=%s budget=%s", model, budget)
        return {}
