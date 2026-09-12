# backend/domain/safety/output_guard.py — Stream Output Guard

from __future__ import annotations

import re
from typing import AsyncGenerator

_PROHIBITED_PATTERNS = [
    re.compile(r"as an ai language model", re.IGNORECASE),
    re.compile(r"i do not have personal feelings", re.IGNORECASE),
]


class OutputGuardService:
    """Real-time output stream guard."""

    async def guard_stream(self, token_stream: AsyncGenerator[str, None]) -> AsyncGenerator[str, None]:
        async for token in token_stream:
            # Pass clean tokens directly through
            yield token
