"""Contracts for structured LLM output.

Models do not reliably emit bare JSON: they wrap it in ```json fences, add a
"reason" key, or name a danger kind we did not list. These contracts are
tolerant of that *shape* noise and strict about *meaning*: an unknown label is
still rejected, but it is never rejected because of formatting. That matters
most on the crisis path, where a rejected parse is reported as "not verified"
and a real imminent-risk verdict must not be lost to a code fence.
"""

from __future__ import annotations

import json
import re
from typing import Any, Literal, Optional, TypeVar

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


ReactionLabel = Literal[
    "smile",
    "laugh",
    "surprise",
    "concern",
    "tender",
    "excited",
    "curious",
    "none",
]
VoiceSafetyLabel = Literal[
    "not_crisis",
    "distress_support",
    "imminent_escalate",
    "crisis_self_harm",
]
DangerKind = Literal["physical", "self_harm", "unspecified"]
_DANGER_KINDS = frozenset({"physical", "self_harm", "unspecified"})

_FENCE = re.compile(r"^```[a-zA-Z0-9_-]*\s*|\s*```$")
_OBJECT = re.compile(r"\{.*\}", re.DOTALL)

T = TypeVar("T", bound=BaseModel)


def extract_json_object(raw: str) -> dict[str, Any]:
    """Pull the JSON object out of a model reply (fences and prose tolerated)."""
    text = _FENCE.sub("", (raw or "").strip()).strip()
    if not text:
        raise ValueError("empty structured response")
    try:
        data = json.loads(text)
    except ValueError:
        match = _OBJECT.search(text)
        if not match:
            raise ValueError("structured response contained no JSON object") from None
        data = json.loads(match.group(0))
    if not isinstance(data, dict):
        raise ValueError("structured response was not a JSON object")
    return data


def parse_provider_output(contract: type[T], raw: str) -> T:
    return contract.model_validate(extract_json_object(raw))


class ProviderOutput(BaseModel):
    model_config = ConfigDict(extra="ignore")


class VoiceReactionOutput(ProviderOutput):
    reaction: ReactionLabel

    @field_validator("reaction", mode="before")
    @classmethod
    def _normalize(cls, value: Any) -> Any:
        return str(value or "").strip().lower() if isinstance(value, str) else value


class VoiceSafetyOutput(ProviderOutput):
    label: VoiceSafetyLabel
    danger_kind: Optional[DangerKind] = None

    @field_validator("label", mode="before")
    @classmethod
    def _normalize_label(cls, value: Any) -> Any:
        return str(value or "").strip().lower() if isinstance(value, str) else value

    @field_validator("danger_kind", mode="before")
    @classmethod
    def _normalize_kind(cls, value: Any) -> Any:
        if value is None:
            return None
        kind = str(value).strip().lower().replace("-", "_").replace(" ", "_")
        if not kind or kind in {"none", "null"}:
            return None
        # "overdose", "suicide", ... are real danger reports with an unlisted
        # name. Keep the escalation; lose only the precision.
        return kind if kind in _DANGER_KINDS else "unspecified"

    @model_validator(mode="after")
    def _kind_matches_label(self) -> "VoiceSafetyOutput":
        if self.label == "imminent_escalate" and self.danger_kind is None:
            self.danger_kind = "unspecified"
        elif self.label != "imminent_escalate":
            self.danger_kind = None
        return self


class ProviderUsage(BaseModel):
    model_config = ConfigDict(extra="ignore")
    prompt_tokens: int = Field(default=0, ge=0)
    completion_tokens: int = Field(default=0, ge=0)
    total_tokens: int = Field(default=0, ge=0)


def _clean_items(value: Any, *, limit: int, chars: int) -> list[str]:
    if not isinstance(value, list):
        return []
    items: list[str] = []
    for item in value:
        text = " ".join(str(item or "").split())[:chars]
        if text and text not in items:
            items.append(text)
        if len(items) >= limit:
            break
    return items


class MemoryDigestOutput(ProviderOutput):
    """Compaction of a batch of conversation turns."""

    digest: str = Field(min_length=1, max_length=1200)
    themes: list[str] = Field(default_factory=list)
    helped: list[str] = Field(default_factory=list)

    @field_validator("themes", "helped", mode="before")
    @classmethod
    def _items(cls, value: Any) -> list[str]:
        return _clean_items(value, limit=5, chars=60)

    facts: list[dict[str, str]] = Field(default_factory=list)

    @field_validator("facts", mode="before")
    @classmethod
    def _facts(cls, value: Any) -> list[dict[str, str]]:
        if not isinstance(value, list):
            return []
        out: list[dict[str, str]] = []
        for item in value[:8]:
            if isinstance(item, dict) and str(item.get("value") or "").strip():
                out.append({"category": str(item.get("category") or "facts")[:24], "value": " ".join(str(item["value"]).split())[:120]})
            elif isinstance(item, str) and item.strip():
                out.append({"category": "facts", "value": " ".join(item.split())[:120]})
        return out


class MemorySummaryOutput(ProviderOutput):
    """The running narrative summary of a person."""

    summary: str = Field(min_length=1, max_length=2000)
    open_threads: list[str] = Field(default_factory=list)

    @field_validator("open_threads", mode="before")
    @classmethod
    def _threads(cls, value: Any) -> list[str]:
        return _clean_items(value, limit=3, chars=120)
