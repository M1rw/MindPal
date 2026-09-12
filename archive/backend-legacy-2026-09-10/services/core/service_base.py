"""
Core service base class and lifecycle patterns.

All backend services should extend ServiceBase to ensure consistent:
- Initialization and configuration
- Startup/shutdown lifecycle
- Health checking
- Error handling and recovery
- Logging and tracing
- Graceful degradation

This module provides the foundation for modern, maintainable services.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


class ServiceError(Exception):
    """Base exception for all service errors."""

    def __init__(
        self,
        message: str,
        service_name: str,
        error_code: str,
        recoverable: bool = False,
        cause: Optional[Exception] = None,
    ):
        self.message = message
        self.service_name = service_name
        self.error_code = error_code
        self.recoverable = recoverable
        self.cause = cause
        super().__init__(message)

    def __str__(self) -> str:
        return f"{self.service_name}: {self.message} ({self.error_code})"


class ConfigError(ServiceError):
    """Raised when service configuration is invalid."""

    def __init__(self, message: str, service_name: str, cause: Optional[Exception] = None):
        super().__init__(
            message=message,
            service_name=service_name,
            error_code="CONFIG_ERROR",
            recoverable=False,
            cause=cause,
        )


class InitializationError(ServiceError):
    """Raised when service initialization fails."""

    def __init__(
        self, message: str, service_name: str, recoverable: bool = False, cause: Optional[Exception] = None
    ):
        super().__init__(
            message=message,
            service_name=service_name,
            error_code="INIT_ERROR",
            recoverable=recoverable,
            cause=cause,
        )


class OperationError(ServiceError):
    """Raised when a service operation fails."""

    def __init__(
        self, message: str, service_name: str, recoverable: bool = True, cause: Optional[Exception] = None
    ):
        super().__init__(
            message=message,
            service_name=service_name,
            error_code="OPERATION_ERROR",
            recoverable=recoverable,
            cause=cause,
        )


class ServiceBase(ABC):
    """
    Abstract base class for all backend services.

    Ensures consistent lifecycle management, error handling, and observability
    across all services.

    Lifecycle:
    1. __init__() - initialize with configuration
    2. start() - establish connections, warm caches
    3. operate - service is available for requests
    4. stop() - gracefully shutdown, cleanup resources

    Health Checking:
    - health() returns current status
    - Can be called at any time
    - Should be fast (<500ms)
    - Indicates if service is ready

    Error Handling:
    - Errors should be raised as specific ServiceError subclasses
    - Include error_code for categorization
    - Set recoverable=True if operation can be retried
    - Include cause exception for debugging

    Example:
        class MyService(ServiceBase):
            def __init__(self, config):
                self.config = config

            async def start(self):
                await self.connection.connect()
                logger.info("MyService started")

            async def stop(self):
                await self.connection.close()

            def health(self) -> Dict[str, Any]:
                return {
                    "status": "healthy" if self.connection.is_connected else "unhealthy",
                    "details": {"connected": self.connection.is_connected}
                }

            async def do_work(self, request):
                try:
                    result = await self.connection.query(request)
                    return result
                except ConnectionError as e:
                    raise OperationError(
                        message="Connection failed during query",
                        service_name=self.__class__.__name__,
                        recoverable=True,
                        cause=e,
                    )
    """

    def __init__(self):
        """Initialize service. Override to add custom initialization."""
        self._started = False
        self._logger = logging.getLogger(self.__class__.__name__)

    @property
    def name(self) -> str:
        """Service name for logging and identification."""
        return self.__class__.__name__

    @property
    def is_started(self) -> bool:
        """Whether service has been started."""
        return self._started

    async def start(self) -> None:
        """
        Start the service and establish connections.

        Called once during application startup. Should:
        - Establish database connections
        - Initialize caches
        - Validate configuration
        - Warm up expensive resources

        Should raise InitializationError if startup fails.

        Default implementation: no-op (override if needed)
        """
        self._started = True
        self._logger.info(f"{self.name} started")

    async def stop(self) -> None:
        """
        Stop the service and cleanup resources.

        Called once during application shutdown. Should:
        - Close connections gracefully
        - Flush pending operations
        - Release resources
        - Cancel background tasks

        Should not raise exceptions (try/except internally)

        Default implementation: no-op (override if needed)
        """
        self._started = False
        self._logger.info(f"{self.name} stopped")

    def health(self) -> Dict[str, Any]:
        """
        Get current health status.

        Returns:
            Dictionary with at minimum:
            - status: "healthy", "degraded", or "unhealthy"
            - uptime_seconds: how long service has been running
            - details: service-specific health information

        Should be fast (<500ms). Can be called at any time, even if
        service is not fully started.

        Example:
            {
                "status": "healthy",
                "uptime_seconds": 3600,
                "details": {
                    "db_connected": True,
                    "cache_size": 1024,
                    "error_rate": 0.001
                }
            }
        """
        return {
            "status": "healthy" if self._started else "unhealthy",
            "uptime_seconds": 0,
            "details": {"started": self._started},
        }

    async def aclose(self) -> None:
        """Compatibility method. Calls stop()."""
        await self.stop()

    def __repr__(self) -> str:
        return f"{self.name}(started={self._started})"
