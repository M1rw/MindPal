"""Bounded, privacy-safe execution trace contracts for MindPal // SAFE MODE."""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.core.security import sanitize_text


class RuntimeEventKind(StrEnum):
    RUN_STARTED = "run.started"
    NODE_STARTED = "node.started"
    NODE_COMPLETED = "node.completed"
    MEMORY_RETRIEVED = "memory.retrieved"
    TOOL_STARTED = "tool.started"
    TOOL_COMPLETED = "tool.completed"
    MODEL_STARTED = "model.started"
    MODEL_COMPLETED = "model.completed"
    ERROR = "error"
    RUN_COMPLETED = "run.completed"


class RuntimeNode(StrEnum):
    INPUT = "input"
    SESSION = "session"
    GUARDRAILS = "guardrails"
    CONTEXT = "context"
    MEMORY = "memory"
    RETRIEVAL = "retrieval"
    TOOL_ROUTER = "tool_router"
    WEB = "web"
    TIME = "time"
    MEMORY_SEARCH = "memory_search"
    MODEL = "model"
    EVALUATOR = "evaluator"
    SYNTHESIS = "synthesis"
    OUTPUT = "output"
    ERROR = "error"


class RuntimeEvent(BaseModel):
    """One safe diagnostic event. Metadata is a shallow numeric/boolean/string map."""

    model_config = ConfigDict(extra="forbid")

    run_id: str = Field(min_length=1, max_length=120)
    sequence: int = Field(ge=1, le=256)
    timestamp_ms: int = Field(ge=0)
    kind: RuntimeEventKind
    node: RuntimeNode
    status: str = Field(min_length=1, max_length=24)
    duration_ms: int | None = Field(default=None, ge=0, le=300_000)
    parent: RuntimeNode | None = None
    metadata: dict[str, str | int | float | bool] = Field(default_factory=dict, max_length=12)

    @field_validator("run_id", "status", mode="before")
    @classmethod
    def clean_text(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), 120)
        if not cleaned:
            raise ValueError("runtime text cannot be empty")
        return cleaned


class RuntimeTrace(BaseModel):
    """Request-scoped SAFE MODE trace embedded in existing chat metadata."""

    model_config = ConfigDict(extra="forbid")

    run_id: str = Field(min_length=1, max_length=120)
    completed: bool = False
    total_duration_ms: int | None = Field(default=None, ge=0, le=300_000)
    events: list[RuntimeEvent] = Field(default_factory=list, max_length=64)
    metrics: dict[str, str | int | float | bool] = Field(default_factory=dict, max_length=16)

    @field_validator("run_id", mode="before")
    @classmethod
    def clean_run_id(cls, value: object) -> str:
        cleaned = sanitize_text(str(value or ""), 120)
        if not cleaned:
            raise ValueError("runtime run id cannot be empty")
        return cleaned


RuntimeScalar = str | int | float | bool


def clean_runtime_metadata(values: dict[str, object] | None) -> dict[str, RuntimeScalar]:
    """Keep only bounded scalar diagnostics—never content, IDs, or nested tool data."""
    clean: dict[str, RuntimeScalar] = {}
    for key, value in (values or {}).items():
        if len(clean) >= 12:
            break
        safe_key = sanitize_text(str(key), 40).lower().replace(" ", "_")
        if not safe_key or safe_key in {"message", "prompt", "reply", "content", "user", "token", "id"}:
            continue
        if isinstance(value, bool):
            clean[safe_key] = value
        elif isinstance(value, int) and not isinstance(value, bool):
            clean[safe_key] = max(-1_000_000, min(1_000_000, value))
        elif isinstance(value, float):
            clean[safe_key] = round(max(-1_000_000.0, min(1_000_000.0, value)), 3)
        elif isinstance(value, str):
            clean_value = sanitize_text(value, 80)
            if clean_value:
                clean[safe_key] = clean_value
    return clean
