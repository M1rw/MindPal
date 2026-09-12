# Shared service base class

from abc import ABC, abstractmethod
from typing import Any, Dict, Optional
import logging

logger = logging.getLogger(__name__)


class Service(ABC):
    """
    Base service class for all domain services.
    
    Provides:
    - Lifecycle management
    - Health checking
    - Error handling
    - Logging
    """
    
    @abstractmethod
    async def start(self) -> None:
        """Start service (connection setup, warmup, etc)."""
        ...
    
    @abstractmethod
    async def stop(self) -> None:
        """Stop service (cleanup, connection close, etc)."""
        ...
    
    @abstractmethod
    async def health(self) -> Dict[str, Any]:
        """Get service health status."""
        ...
    
    async def __aenter__(self):
        """Async context manager enter."""
        await self.start()
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit."""
        await self.stop()
        return False

