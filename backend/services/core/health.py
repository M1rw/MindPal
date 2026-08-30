# Health Checks and Observability

from dataclasses import dataclass, asdict
from datetime import datetime
from enum import Enum
from typing import Any, Callable, Optional
import asyncio
import logging
import time

logger = logging.getLogger(__name__)


class HealthStatus(Enum):
    """Health status of a service."""
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNHEALTHY = "unhealthy"


@dataclass
class ServiceHealth:
    """Health status of a single service."""
    name: str
    status: HealthStatus
    last_check: datetime
    latency_ms: float
    errors: Optional[list[str]] = None
    metadata: Optional[dict[str, Any]] = None
    
    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "name": self.name,
            "status": self.status.value,
            "last_check": self.last_check.isoformat(),
            "latency_ms": self.latency_ms,
            "errors": self.errors or [],
            "metadata": self.metadata or {},
        }


@dataclass
class SystemHealth:
    """Overall system health."""
    status: HealthStatus
    last_check: datetime
    services: dict[str, ServiceHealth]
    
    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "status": self.status.value,
            "last_check": self.last_check.isoformat(),
            "services": {
                name: service.to_dict()
                for name, service in self.services.items()
            }
        }


class HealthChecker:
    """
    Centralized health checking for all services.
    
    Usage:
        checker = HealthChecker()
        checker.register("database", check_database)
        checker.register("llm_api", check_llm_api)
        
        health = await checker.check_all()
        overall = checker.get_overall_status()
    """
    
    def __init__(self, timeout_seconds: float = 5.0):
        self._checks: dict[str, Callable[[], Any]] = {}
        self._results: dict[str, ServiceHealth] = {}
        self._timeout = timeout_seconds
        self._lock = asyncio.Lock()
    
    def register(
        self,
        name: str,
        check_func: Callable[[], Any],
    ) -> None:
        """
        Register a health check.
        
        Args:
            name: Service name
            check_func: Async function that returns None (healthy) or dict with status info
                       Should raise exception if unhealthy
        """
        self._checks[name] = check_func
    
    async def check(self, name: str) -> ServiceHealth:
        """
        Run a single health check.
        
        Args:
            name: Service name
            
        Returns:
            ServiceHealth result
        """
        if name not in self._checks:
            return ServiceHealth(
                name=name,
                status=HealthStatus.UNHEALTHY,
                last_check=datetime.utcnow(),
                latency_ms=0,
                errors=["Service not found"]
            )
        
        check_func = self._checks[name]
        start = time.time()
        
        try:
            # Run check with timeout
            result = await asyncio.wait_for(
                self._run_check(check_func),
                timeout=self._timeout
            )
            latency_ms = (time.time() - start) * 1000
            
            # Determine status from result
            if isinstance(result, dict):
                status = HealthStatus[result.get("status", "HEALTHY").upper()]
                errors = result.get("errors")
                metadata = result.get("metadata")
            else:
                status = HealthStatus.HEALTHY
                errors = None
                metadata = None
            
            health = ServiceHealth(
                name=name,
                status=status,
                last_check=datetime.utcnow(),
                latency_ms=latency_ms,
                errors=errors,
                metadata=metadata,
            )
        except asyncio.TimeoutError:
            latency_ms = (time.time() - start) * 1000
            health = ServiceHealth(
                name=name,
                status=HealthStatus.UNHEALTHY,
                last_check=datetime.utcnow(),
                latency_ms=latency_ms,
                errors=[f"Health check timed out after {self._timeout}s"]
            )
        except Exception as e:
            latency_ms = (time.time() - start) * 1000
            health = ServiceHealth(
                name=name,
                status=HealthStatus.UNHEALTHY,
                last_check=datetime.utcnow(),
                latency_ms=latency_ms,
                errors=[f"{type(e).__name__}: {str(e)[:100]}"]
            )
        
        # Store result
        async with self._lock:
            self._results[name] = health
        
        return health
    
    async def check_all(self) -> dict[str, ServiceHealth]:
        """
        Run all health checks in parallel.
        
        Returns:
            Dictionary of service name -> ServiceHealth
        """
        tasks = [
            self.check(name)
            for name in self._checks.keys()
        ]
        
        if not tasks:
            return {}
        
        results = await asyncio.gather(*tasks, return_exceptions=False)
        return {health.name: health for health in results}
    
    async def get_system_health(self) -> SystemHealth:
        """
        Get overall system health.
        
        Returns:
            SystemHealth with overall status
        """
        await self.check_all()
        
        services = dict(self._results)
        
        # Determine overall status
        if not services:
            overall_status = HealthStatus.HEALTHY
        else:
            statuses = [s.status for s in services.values()]
            if HealthStatus.UNHEALTHY in statuses:
                overall_status = HealthStatus.UNHEALTHY
            elif HealthStatus.DEGRADED in statuses:
                overall_status = HealthStatus.DEGRADED
            else:
                overall_status = HealthStatus.HEALTHY
        
        return SystemHealth(
            status=overall_status,
            last_check=datetime.utcnow(),
            services=services
        )
    
    async def _run_check(self, check_func: Callable[[], Any]) -> Any:
        """Run check function (handles sync/async)."""
        if asyncio.iscoroutinefunction(check_func):
            return await check_func()
        else:
            return check_func()


class MetricsCollector:
    """
    Collects metrics for observability.
    
    Tracks:
    - Request counts and latencies
    - Error rates
    - Provider-specific metrics
    - Cache hit ratios
    - Circuit breaker states
    """
    
    def __init__(self):
        self._metrics: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()
    
    async def record_request(
        self,
        service: str,
        operation: str,
        duration_ms: float,
        status: str = "success",
        error: Optional[str] = None,
    ) -> None:
        """
        Record a request/operation.
        
        Args:
            service: Service name
            operation: Operation name
            duration_ms: Request duration
            status: "success", "error", "timeout"
            error: Error message if applicable
        """
        key = f"{service}:{operation}"
        
        async with self._lock:
            if key not in self._metrics:
                self._metrics[key] = {
                    "count": 0,
                    "success": 0,
                    "error": 0,
                    "timeout": 0,
                    "total_duration_ms": 0.0,
                    "min_duration_ms": float('inf'),
                    "max_duration_ms": 0.0,
                    "errors": [],
                }
            
            metric = self._metrics[key]
            metric["count"] += 1
            metric[status] = metric.get(status, 0) + 1
            metric["total_duration_ms"] += duration_ms
            metric["min_duration_ms"] = min(metric["min_duration_ms"], duration_ms)
            metric["max_duration_ms"] = max(metric["max_duration_ms"], duration_ms)
            
            if error and len(metric["errors"]) < 10:
                metric["errors"].append(f"{error}")
    
    async def get_metrics(self, service: Optional[str] = None) -> dict[str, Any]:
        """Get collected metrics."""
        async with self._lock:
            metrics = dict(self._metrics)
        
        # Calculate aggregates
        result = {}
        for key, metric in metrics.items():
            if service and not key.startswith(service):
                continue
            
            count = metric.get("count", 0)
            result[key] = {
                **metric,
                "avg_duration_ms": metric["total_duration_ms"] / count if count > 0 else 0,
                "success_rate": metric.get("success", 0) / count if count > 0 else 0,
                "error_rate": metric.get("error", 0) / count if count > 0 else 0,
                "timeout_rate": metric.get("timeout", 0) / count if count > 0 else 0,
            }
        
        return result
    
    async def reset(self) -> None:
        """Reset all metrics."""
        async with self._lock:
            self._metrics.clear()


# Global instances
_health_checker = HealthChecker()
_metrics_collector = MetricsCollector()


async def get_health_checker() -> HealthChecker:
    """Get global health checker."""
    return _health_checker


async def get_metrics_collector() -> MetricsCollector:
    """Get global metrics collector."""
    return _metrics_collector

