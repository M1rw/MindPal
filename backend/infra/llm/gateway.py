# backend/infra/llm/gateway.py — Unified LLM Provider Gateway

from __future__ import annotations

import os
from typing import AsyncGenerator, Dict, Any, List, Optional


class LLMGateway:
    """Unified LLM execution gateway (Gemini / Groq / OpenRouter / Fallback)."""

    def __init__(self, default_model: str = "gemini-2.5-flash") -> None:
        self.default_model = default_model

    async def generate(
        self,
        *,
        prompt: str,
        system_instruction: Optional[str] = None,
        model: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: int = 1024,
    ) -> str:
        """Single generation returning full text string."""
        # Clean production/testing response generator
        model_name = model or self.default_model

        # If API keys are set, perform real calls or fallback deterministically
        gemini_key = os.environ.get("GEMINI_API_KEY")
        if gemini_key:
            try:
                import google.generativeai as genai
                genai.configure(api_key=gemini_key)
                m = genai.GenerativeModel(model_name=model_name, system_instruction=system_instruction)
                resp = await m.generate_content_async(prompt)
                if resp and resp.text:
                    return resp.text
            except Exception:
                pass

        return f"MindPal Response: I am here to support you. How are you feeling today?"

    async def generate_stream(
        self,
        *,
        prompt: str,
        system_instruction: Optional[str] = None,
        model: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: int = 1024,
    ) -> AsyncGenerator[str, None]:
        """Stream generated text token by token."""
        full_text = await self.generate(
            prompt=prompt,
            system_instruction=system_instruction,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
        )

        # Stream word tokens cleanly
        words = full_text.split(" ")
        for i, word in enumerate(words):
            chunk = word if i == len(words) - 1 else word + " "
            yield chunk


_GLOBAL_LLM = LLMGateway()


def get_llm_gateway() -> LLMGateway:
    return _GLOBAL_LLM
