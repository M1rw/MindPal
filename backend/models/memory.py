from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, model_validator


class MemoryAtom(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    id: str = Field(min_length=1)
    category: str = "facts"
    value: str = ""
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)


class MemoryGraph(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    user_id_hash: str = ""
    summary: str = ""
    atoms: list[MemoryAtom] = Field(default_factory=list)


class MemoryGraphLoadResult(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    user_id_hash: str = ""
    summary: str = ""
    atoms: list[MemoryAtom] = Field(default_factory=list)
    loaded: bool = True
    provider: str | None = None
    graph: MemoryGraph | None = None

    @model_validator(mode="before")
    @classmethod
    def _normalize_flat_payload(cls, data):
        if not isinstance(data, dict):
            return data
        graph_data = data.get("graph")
        if graph_data is None:
            graph_data = {
                "user_id_hash": data.get("user_id_hash", ""),
                "summary": data.get("summary", ""),
                "atoms": data.get("atoms", []),
            }
        if isinstance(graph_data, dict):
            payload = dict(data)
            payload.setdefault("graph", graph_data)
            payload.setdefault("user_id_hash", graph_data.get("user_id_hash", data.get("user_id_hash", "")))
            payload.setdefault("summary", graph_data.get("summary", data.get("summary", "")))
            payload.setdefault("atoms", graph_data.get("atoms", data.get("atoms", [])))
            return payload
        return data


class MemoryCompactionResult(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    summary: str = ""
    atom_count: int = 0
    updated: bool = False
