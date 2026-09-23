from __future__ import annotations

import time
from typing import Any, Dict

from backend.configs.runtime import voice_runtime_config

_TRANSCRIPT_CONFIG = voice_runtime_config()["session"]
TRANSCRIPT_BUFFER_CHARS = int(_TRANSCRIPT_CONFIG["transcript_buffer_chars"])
LEDGER_CHARS = int(_TRANSCRIPT_CONFIG["ledger_chars"])


def window(text: Any, limit: int = TRANSCRIPT_BUFFER_CHARS) -> str:
    value = " ".join(str(text or "").split())
    if len(value) <= limit:
        return value
    return value[-limit:]


def append(buffer: Any, delta: Any, limit: int = TRANSCRIPT_BUFFER_CHARS) -> str:
    return window(f"{buffer or ''} {delta or ''}", limit)


def speech_delta(prior: Any, current: Any) -> str:
    before = " ".join(str(prior or "").split())
    after = " ".join(str(current or "").split())
    if not after or after == before:
        return ""
    if not before:
        return after
    if after.startswith(before):
        return after[len(before):].strip()
    if before in after:
        return after.split(before, 1)[-1].strip()
    tail = before[-min(48, len(before)):]
    pos = after.find(tail)
    if pos >= 0:
        return after[pos + len(tail):].strip()
    return ""


def compact_working_memory(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Keep a bounded session graph on the server record."""
    def string_list(value: Any, *, limit: int, item_len: int) -> list[str]:
        if not isinstance(value, list):
            return []
        result: list[str] = []
        for item in value:
            text = " ".join(str(item or "").split())[:item_len]
            if text and text not in result:
                result.append(text)
            if len(result) >= limit:
                break
        return result

    edges: list[Dict[str, str]] = []
    for edge in (raw.get("edges") if isinstance(raw.get("edges"), list) else [])[:12]:
        if not isinstance(edge, dict):
            continue
        source = " ".join(str(edge.get("from") or "").split())[:60]
        target = " ".join(str(edge.get("to") or "").split())[:60]
        relation = " ".join(str(edge.get("rel") or "").split())[:32]
        if source and target and relation:
            edges.append({"from": source, "to": target, "rel": relation})

    timeline: list[Dict[str, str]] = []
    for row in (raw.get("timeline") if isinstance(raw.get("timeline"), list) else [])[-10:]:
        if not isinstance(row, dict):
            continue
        summary = " ".join(str(row.get("summary") or "").split())[:140]
        if summary:
            timeline.append({
                "role": "user" if str(row.get("role") or "") == "user" else "model",
                "summary": summary,
            })

    return {
        "topics": string_list(raw.get("topics"), limit=8, item_len=80),
        "open_questions": string_list(raw.get("open_questions"), limit=4, item_len=120),
        "user_facts_this_session": string_list(raw.get("user_facts_this_session"), limit=6, item_len=100),
        "last_user_intent": " ".join(str(raw.get("last_user_intent") or "").split())[:160],
        "edges": edges,
        "timeline": timeline,
        "updated_at": time.time(),
    }
