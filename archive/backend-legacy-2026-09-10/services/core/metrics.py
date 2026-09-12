from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from time import time
from typing import Any


@dataclass(slots=True)
class CounterMetric:
    name: str
    help: str
    value: int = 0
    labels: dict[str, str] = field(default_factory=dict)

    def inc(self, amount: int = 1) -> None:
        self.value += amount

    def render(self) -> str:
        label_text = "" if not self.labels else "{" + ",".join(f'{key}="{value}"' for key, value in sorted(self.labels.items())) + "}"
        return f'# HELP {self.name} {self.help}\n# TYPE {self.name} counter\n{self.name}{label_text} {self.value}\n'


@dataclass(slots=True)
class GaugeMetric:
    name: str
    help: str
    value: float = 0.0
    labels: dict[str, str] = field(default_factory=dict)

    def set(self, value: float) -> None:
        self.value = value

    def inc(self, amount: float = 1.0) -> None:
        self.value += amount

    def render(self) -> str:
        label_text = "" if not self.labels else "{" + ",".join(f'{key}="{value}"' for key, value in sorted(self.labels.items())) + "}"
        return f'# HELP {self.name} {self.help}\n# TYPE {self.name} gauge\n{self.name}{label_text} {self.value}\n'


@dataclass(slots=True)
class HistogramMetric:
    name: str
    help: str
    count: int = 0
    sum: float = 0.0
    bucket_upper_bounds: tuple[float, ...] = (50.0, 100.0, 250.0, 500.0, 1000.0, 2500.0, 5000.0, 10000.0)
    buckets: dict[float, int] = field(default_factory=dict)
    labels: dict[str, str] = field(default_factory=dict)

    def observe(self, duration_ms: float) -> None:
        self.count += 1
        self.sum += duration_ms
        for upper in self.bucket_upper_bounds:
            if duration_ms <= upper:
                self.buckets[upper] = self.buckets.get(upper, 0) + 1

    def render(self) -> str:
        label_text = "" if not self.labels else "{" + ",".join(f'{key}="{value}"' for key, value in sorted(self.labels.items())) + "}"
        lines = [
            f'# HELP {self.name} {self.help}',
            f'# TYPE {self.name} histogram',
            f'{self.name}_count{label_text} {self.count}',
            f'{self.name}_sum{label_text} {self.sum}',
        ]
        for upper in self.bucket_upper_bounds:
            bucket_count = self.buckets.get(upper, 0)
            lines.append(f'{self.name}_bucket{label_text}{{le="{upper}"}} {bucket_count}')
        return "\n".join(lines) + "\n"


class MetricsRegistry:
    """Small Prometheus-compatible metrics registry for backend services."""

    def __init__(self, namespace: str = "mindpal") -> None:
        self.namespace = namespace.strip("_")
        self._counters: dict[tuple[str, tuple[tuple[str, str], ...]], CounterMetric] = {}
        self._gauges: dict[tuple[str, tuple[tuple[str, str], ...]], GaugeMetric] = {}
        self._histograms: dict[tuple[str, tuple[tuple[str, str], ...]], HistogramMetric] = {}

    def _namespaced(self, name: str) -> str:
        return f"{self.namespace}_{name}"

    def counter(self, name: str, help: str, **labels: str) -> CounterMetric:
        key = (self._namespaced(name), tuple(sorted(labels.items())))
        metric = self._counters.get(key)
        if metric is None:
            metric = CounterMetric(self._namespaced(name), help, labels=dict(labels))
            self._counters[key] = metric
        return metric

    def gauge(self, name: str, help: str, **labels: str) -> GaugeMetric:
        key = (self._namespaced(name), tuple(sorted(labels.items())))
        metric = self._gauges.get(key)
        if metric is None:
            metric = GaugeMetric(self._namespaced(name), help, labels=dict(labels))
            self._gauges[key] = metric
        return metric

    def histogram(self, name: str, help: str, **labels: str) -> HistogramMetric:
        key = (self._namespaced(name), tuple(sorted(labels.items())))
        metric = self._histograms.get(key)
        if metric is None:
            metric = HistogramMetric(self._namespaced(name), help, labels=dict(labels))
            self._histograms[key] = metric
        return metric

    def increment(self, name: str, help: str = "counter", **labels: str) -> None:
        self.counter(name, help, **labels).inc()

    def record_duration(self, name: str, duration_ms: float, help: str = "service latency", **labels: str) -> None:
        self.histogram(name, help, **labels).observe(duration_ms)

    def set_gauge(self, name: str, value: float, help: str = "gauge", **labels: str) -> None:
        self.gauge(name, help, **labels).set(value)

    def render_prometheus(self) -> str:
        lines: list[str] = []
        for metric in sorted(self._counters.values(), key=lambda item: item.name):
            lines.append(metric.render().rstrip())
        for metric in sorted(self._gauges.values(), key=lambda item: item.name):
            lines.append(metric.render().rstrip())
        for metric in sorted(self._histograms.values(), key=lambda item: item.name):
            lines.append(metric.render().rstrip())
        return "\n".join(lines) + "\n"


_default_registry = MetricsRegistry()


def get_metrics_registry() -> MetricsRegistry:
    return _default_registry


def record_service_request(service: str, operation: str, duration_ms: float, status: str = "success") -> None:
    registry = get_metrics_registry()
    registry.increment("service_requests_total", "total service requests", service=service, operation=operation, status=status)
    registry.record_duration("service_request_duration_ms", duration_ms, "service request latency in milliseconds", service=service, operation=operation)


def record_provider_request(provider: str, operation: str, duration_ms: float, status: str = "success") -> None:
    registry = get_metrics_registry()
    registry.increment("provider_requests_total", "total provider requests", provider=provider, operation=operation, status=status)
    registry.record_duration("provider_request_duration_ms", duration_ms, "provider request latency in milliseconds", provider=provider, operation=operation)


def render_metrics() -> str:
    return get_metrics_registry().render_prometheus()
