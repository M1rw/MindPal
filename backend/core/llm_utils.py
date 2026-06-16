# backend/core/llm_utils.py
"""
Lightweight multi-provider LLM utility for quick, short generations.

Usage:
    from backend.core.llm_utils import quick_llm_generate

    summary = await quick_llm_generate(
        "Summarize this in one sentence: ...",
        max_tokens=60,
        temperature=0.2,
    )

Provider fallback order: Gemini → Cloudflare → Groq → OpenRouter
Skips any provider that isn't configured. Returns empty string if all fail.
"""

from __future__ import annotations

import os
from typing import Optional

import httpx

from backend.core.config import get_settings


async def quick_llm_generate(
    prompt: str,
    *,
    max_tokens: int = 120,
    temperature: float = 0.3,
    timeout: float = 15.0,
) -> str:
    """
    Send a prompt to the first available LLM provider and return the text.

    Tries providers in order: Gemini → Cloudflare → Groq → OpenRouter.
    Returns the generated text, or empty string if all providers fail.
    """
    settings = get_settings()

    # ── 1. Gemini (multiple model fallback) ──
    result = await _try_gemini(settings, prompt, max_tokens, temperature, timeout)
    if result:
        return result

    # ── 2. Cloudflare Workers AI ──
    result = await _try_cloudflare(settings, prompt, max_tokens, temperature, timeout)
    if result:
        return result

    # ── 3. Groq ──
    result = await _try_groq(settings, prompt, max_tokens, temperature, timeout)
    if result:
        return result

    # ── 4. OpenRouter ──
    result = await _try_openrouter(settings, prompt, max_tokens, temperature, timeout)
    if result:
        return result

    return ""


# ═══════════════════════════════════════════════════
# Provider implementations
# ═══════════════════════════════════════════════════

async def _try_gemini(
    settings, prompt: str, max_tokens: int, temperature: float, timeout: float
) -> str:
    key = _get_secret(settings, "GEMINI_API_KEY")
    if not key:
        return ""

    models = [
        "models/gemini-2.0-flash",
        "models/gemini-2.0-flash-lite",
        "models/gemini-1.5-flash",
        "models/gemini-1.5-flash-latest",
    ]
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"maxOutputTokens": max_tokens, "temperature": temperature},
    }

    async with httpx.AsyncClient(timeout=timeout) as client:
        for model in models:
            url = f"https://generativelanguage.googleapis.com/v1beta/{model}:generateContent?key={key}"
            try:
                resp = await client.post(url, headers={"Content-Type": "application/json"}, json=payload)
                if resp.status_code == 404:
                    continue
                resp.raise_for_status()
                candidates = resp.json().get("candidates", [])
                if candidates:
                    parts = candidates[0].get("content", {}).get("parts", [])
                    text = "".join(p.get("text", "") for p in parts).strip()
                    if text:
                        return text
            except Exception:
                continue
    return ""


async def _try_cloudflare(
    settings, prompt: str, max_tokens: int, temperature: float, timeout: float
) -> str:
    token = (
        _get_secret(settings, "CLOUDFLARE_AIG_TOKEN")
        or _get_secret(settings, "CLOUDFLARE_API_TOKEN")
        or os.getenv("CLOUDFLARE_AIG_TOKEN", "")
        or os.getenv("CLOUDFLARE_API_TOKEN", "")
    )
    account_id = (
        str(getattr(settings, "CLOUDFLARE_ACCOUNT_ID", "") or "")
        or os.getenv("CLOUDFLARE_ACCOUNT_ID", "")
        or os.getenv("CF_ACCOUNT_ID", "")
    )
    gateway_id = (
        str(getattr(settings, "CLOUDFLARE_GATEWAY_ID", "") or "")
        or os.getenv("CLOUDFLARE_GATEWAY_ID", "")
        or "default"
    )

    if not token or not account_id:
        return ""

    url = f"https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat/chat/completions"
    payload = {
        "model": "workers-ai/@cf/meta/llama-3.1-8b-instruct-fp8-fast",
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": temperature,
    }

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                url,
                headers={"cf-aig-authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json=payload,
            )
            resp.raise_for_status()
            return _extract_openai_text(resp.json())
    except Exception:
        return ""


async def _try_groq(
    settings, prompt: str, max_tokens: int, temperature: float, timeout: float
) -> str:
    key = _get_secret(settings, "GROQ_API_KEY")
    if not key:
        return ""

    payload = {
        "model": "llama-3.1-8b-instant",
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": temperature,
    }

    try:
        async with httpx.AsyncClient(timeout=min(timeout, 10.0)) as client:
            resp = await client.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json=payload,
            )
            resp.raise_for_status()
            return _extract_openai_text(resp.json())
    except Exception:
        return ""


async def _try_openrouter(
    settings, prompt: str, max_tokens: int, temperature: float, timeout: float
) -> str:
    key = _get_secret(settings, "OPENROUTER_API_KEY")
    if not key:
        return ""

    payload = {
        "model": "openai/gpt-4o-mini",
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": temperature,
    }

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json=payload,
            )
            resp.raise_for_status()
            return _extract_openai_text(resp.json())
    except Exception:
        return ""


# ═══════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════

def _extract_openai_text(data: dict) -> str:
    """Extract text from an OpenAI-compatible chat completion response."""
    try:
        return data.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
    except (IndexError, AttributeError):
        return ""


def _get_secret(settings, name: str) -> str:
    """Safely extract a secret string from settings."""
    value = getattr(settings, name, None)
    if hasattr(value, "get_secret_value"):
        return value.get_secret_value() or ""
    return str(value or "").strip()
