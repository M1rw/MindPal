"""Request-scoped, privacy-safe runtime tracing for MindPal // SAFE MODE."""

from __future__ import annotations

from time import perf_counter
from typing import Any

from backend.models.runtime_trace import (
    RuntimeEvent,
    RuntimeEventKind,
    RuntimeNode,
    RuntimeTrace,
    clean_runtime_metadata,
)


class RuntimeTraceRecorder:
    """Records bounded runtime transitions without recording user or provider content."""

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        self._started_at = perf_counter()
        self._events: list[RuntimeEvent] = []
        self._node_started_at: dict[RuntimeNode, float] = {}
        self._completed = False
        self._metrics: dict[str, str | int | float | bool] = {}

    def started(self, *, metadata: dict[str, Any] | None = None) -> None:
        self._append(RuntimeEventKind.RUN_STARTED, RuntimeNode.INPUT, "started", metadata=metadata)

    def node_started(
        self,
        node: RuntimeNode,
        *,
        parent: RuntimeNode | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self._node_started_at[node] = perf_counter()
        kind = RuntimeEventKind.MODEL_STARTED if node is RuntimeNode.MODEL else RuntimeEventKind.TOOL_STARTED if node in {RuntimeNode.WEB, RuntimeNode.TIME, RuntimeNode.MEMORY_SEARCH} else RuntimeEventKind.NODE_STARTED
        self._append(kind, node, "active", parent=parent, metadata=metadata)

    def node_completed(
        self,
        node: RuntimeNode,
        *,
        parent: RuntimeNode | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        started = self._node_started_at.pop(node, None)
        duration = None if started is None else round((perf_counter() - started) * 1_000)
        if node is RuntimeNode.MEMORY:
            kind = RuntimeEventKind.MEMORY_RETRIEVED
        elif node is RuntimeNode.MODEL:
            kind = RuntimeEventKind.MODEL_COMPLETED
        elif node in {RuntimeNode.WEB, RuntimeNode.TIME, RuntimeNode.MEMORY_SEARCH}:
            kind = RuntimeEventKind.TOOL_COMPLETED
        else:
            kind = RuntimeEventKind.NODE_COMPLETED
        self._append(kind, node, "completed", parent=parent, duration_ms=duration, metadata=metadata)

    def failed(self, node: RuntimeNode, *, code: str = "runtime_error") -> None:
        started = self._node_started_at.pop(node, None)
        duration = None if started is None else round((perf_counter() - started) * 1_000)
        self._append(RuntimeEventKind.ERROR, node, "failed", duration_ms=duration, metadata={"code": code})

    def complete(self, *, metadata: dict[str, Any] | None = None) -> None:
        if self._completed:
            return
        self._completed = True
        total = round((perf_counter() - self._started_at) * 1_000)
        self._metrics.update(clean_runtime_metadata(metadata))
        self._append(RuntimeEventKind.RUN_COMPLETED, RuntimeNode.OUTPUT, "completed", duration_ms=total, metadata=metadata)

    def trace(self) -> RuntimeTrace:
        total = round((perf_counter() - self._started_at) * 1_000) if self._completed else None
        return RuntimeTrace(
            run_id=self.run_id,
            completed=self._completed,
            total_duration_ms=total,
            events=list(self._events),
            metrics=dict(self._metrics),
        )

    def _append(
        self,
        kind: RuntimeEventKind,
        node: RuntimeNode,
        status: str,
        *,
        parent: RuntimeNode | None = None,
        duration_ms: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        if len(self._events) >= 64:
            return
        self._events.append(
            RuntimeEvent(
                run_id=self.run_id,
                sequence=len(self._events) + 1,
                timestamp_ms=round((perf_counter() - self._started_at) * 1_000),
                kind=kind,
                node=node,
                status=status,
                duration_ms=duration_ms,
                parent=parent,
                metadata=clean_runtime_metadata(metadata),
            )
        )
