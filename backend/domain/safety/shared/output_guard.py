# backend/domain/safety/output_guard.py — Stream Output Guard

from __future__ import annotations

import re
from contextlib import aclosing
from typing import AsyncGenerator

from backend.configs.runtime import safety_config

# Boilerplate that breaks the companion voice. Written against the accumulated
# text, so a phrase split across token boundaries still matches.
_SAFETY_CONFIG = safety_config()
_PROHIBITED_PATTERNS = [
    re.compile(pattern, re.IGNORECASE)
    for pattern in _SAFETY_CONFIG["output_guard"]["prohibited_patterns"]
]

# The longest prohibited phrase, plus slack. Only this much tail needs to be
# re-examined as new tokens arrive; matching against the whole transcript made
# every token cost more than the one before it, so a long reply degraded into
# quadratic regex work while the caller waited on the stream.
_SCAN_WINDOW_CHARS = int(_SAFETY_CONFIG["output_guard"]["scan_window_chars"])


class OutputGuardService:
    """Best-effort live filter. Does not delay the stream behind a full buffer."""

    async def guard_stream(self, token_stream: AsyncGenerator[str, None]) -> AsyncGenerator[str, None]:
        tail = ""
        async with aclosing(token_stream) as stream:
            async for token in stream:
                if not token:
                    continue
                trial = tail + token
                if any(pattern.search(trial) for pattern in _PROHIBITED_PATTERNS):
                    # Drop the token and keep the tail unchanged: the next token
                    # is judged against the same context, so a phrase cannot be
                    # smuggled through by splitting it differently.
                    continue
                tail = trial[-_SCAN_WINDOW_CHARS:]
                yield token
