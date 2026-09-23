from __future__ import annotations

import logging
import threading
import time
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Protocol
from backend.core.request_context import request_id, set_request_id

logger = logging.getLogger("mindpal.metrics")
@dataclass(frozen=True, slots=True)
class ProviderMetric:
    provider: str
    operation: str
    duration_ms: int
    success: bool
    fallback: bool = False
    retries: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    rate_limited: bool = False


@dataclass(frozen=True, slots=True)
class VoiceMetric:
    operation: str
    duration_ms: int
    outcome: str
    status_code: int


class MetricsExporter(Protocol):
    def export(self, metric_type: str, payload: dict[str, Any]) -> None:
        """Export a bounded, non-sensitive metric event."""


class StoreMetricsExporter:
    """Durable adapter for metrics stores implementing set_document."""

    def __init__(self, store: Any, *, collection: str = "observability_metrics") -> None:
        self.store = store
        self.collection = collection

    def export(self, metric_type: str, payload: dict[str, Any]) -> None:
        now = time.time()
        safe = {
            "metric_type": metric_type[:32],
            "request_id": request_id()[:128],
            "ts": now,
            "operation": str(payload.get("operation") or "")[:32],
            "outcome": str(payload.get("outcome") or "")[:32],
            "duration_ms": max(0, int(payload.get("duration_ms") or 0)),
            "status_code": max(0, int(payload.get("status_code") or 0)),
            "provider": str(payload.get("provider") or "")[:32],
            "success": bool(payload.get("success")),
            "fallback": bool(payload.get("fallback")),
            "retries": max(0, int(payload.get("retries") or 0)),
        }
        document_id = (
            f"{metric_type}:{safe['operation']}:{safe['outcome']}:{int(now * 1000000)}:{threading.get_ident()}"
        )
        self.store.set_document(self.collection, document_id, safe)


class ProviderMetrics:
    """Small process-local counter and structured event sink.

    The counters are intentionally bounded by provider/operation labels and are
    suitable for serverless diagnostics without retaining prompts, responses, or
    credentials. Logs remain the export path until a remote metrics backend is
    configured.
    """

    def __init__(self, exporter: MetricsExporter | None = None) -> None:
        self._lock = threading.Lock()
        self._counts: dict[tuple[str, str, str], int] = defaultdict(int)
        self._exporter = exporter

    def record(self, metric: ProviderMetric) -> None:
        outcome = "success" if metric.success else "failure"
        with self._lock:
            self._counts[(metric.provider, metric.operation, outcome)] += 1
            if metric.fallback:
                self._counts[(metric.provider, metric.operation, "fallback")] += 1
            if metric.retries:
                self._counts[(metric.provider, metric.operation, "retry")] += metric.retries
        try:
            from backend.infra.observability.pulse import platform_pulse

            platform_pulse().record_llm(
                success=metric.success,
                latency_ms=metric.duration_ms,
                rate_limited=metric.rate_limited,
                tokens=metric.prompt_tokens + metric.completion_tokens,
            )
        except Exception:
            logger.debug("pulse_record_llm_skipped", exc_info=True)
        logger.info(
            "provider_metric request_id=%s provider=%s operation=%s duration_ms=%s success=%s fallback=%s retries=%s prompt_tokens=%s completion_tokens=%s",
            request_id() or "none",
            metric.provider,
            metric.operation,
            metric.duration_ms,
            metric.success,
            metric.fallback,
            metric.retries,
            metric.prompt_tokens,
            metric.completion_tokens,
        )
        self._export("provider", {"provider": metric.provider, "operation": metric.operation, "duration_ms": metric.duration_ms, "success": metric.success, "fallback": metric.fallback, "retries": metric.retries})

    def _export(self, metric_type: str, payload: dict[str, Any]) -> None:
        if not self._exporter:
            return
        try:
            self._exporter.export(metric_type, payload)
        except Exception:
            logger.warning("metrics_export_failed metric_type=%s", metric_type, exc_info=True)

    def snapshot(self) -> dict[str, int]:
        with self._lock:
            return {f"{provider}.{operation}.{outcome}": count for (provider, operation, outcome), count in self._counts.items()}


_PROVIDER_METRICS = ProviderMetrics()


def provider_metrics() -> ProviderMetrics:
    return _PROVIDER_METRICS


class VoiceMetrics:
    """Bounded process-local counters for voice HTTP health signals."""

    def __init__(self, exporter: MetricsExporter | None = None) -> None:
        self._lock = threading.Lock()
        self._counts: dict[tuple[str, str], int] = defaultdict(int)
        self._latency_ms: dict[str, int] = defaultdict(int)
        self._exporter = exporter

    def record(self, metric: VoiceMetric) -> None:
        operation = metric.operation[:32]
        outcome = metric.outcome[:32]
        with self._lock:
            self._counts[(operation, outcome)] += 1
            self._latency_ms[operation] += max(0, metric.duration_ms)
        logger.info(
            "voice_metric request_id=%s operation=%s outcome=%s status_code=%s duration_ms=%s",
            request_id() or "none",
            operation,
            outcome,
            metric.status_code,
            metric.duration_ms,
        )
        self._export("voice", {"operation": operation, "outcome": outcome, "duration_ms": metric.duration_ms, "status_code": metric.status_code})

    def _export(self, metric_type: str, payload: dict[str, Any]) -> None:
        if not self._exporter:
            return
        try:
            self._exporter.export(metric_type, payload)
        except Exception:
            logger.warning("metrics_export_failed metric_type=%s", metric_type, exc_info=True)

    def snapshot(self) -> dict[str, int]:
        with self._lock:
            snapshot = {
                f"{operation}.{outcome}": count
                for (operation, outcome), count in self._counts.items()
            }
            snapshot.update({f"{operation}.duration_ms": total for operation, total in self._latency_ms.items()})
            return snapshot


_VOICE_METRICS = VoiceMetrics()


def voice_metrics() -> VoiceMetrics:
    return _VOICE_METRICS


def configure_metrics_exporter(exporter: MetricsExporter | None) -> None:
    _PROVIDER_METRICS._exporter = exporter
    _VOICE_METRICS._exporter = exporter


def elapsed_ms(start: float) -> int:
    return max(0, int((time.perf_counter() - start) * 1000))
