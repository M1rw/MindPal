# Shared repository base class

from abc import ABC, abstractmethod
from typing import Any, Callable, Dict, Optional, TypeVar
from datetime import datetime

T = TypeVar('T')


class Repository(ABC):
    """
    Base repository class for all domain repositories.
    
    Provides:
    - CRUD operations interface
    - Caching support via mixin
    - Error handling
    - Audit trails
    """
    
    @abstractmethod
    async def get(self, key: str) -> Optional[T]:
        """Get entity by key."""
        ...
    
    @abstractmethod
    async def set(self, key: str, value: T) -> None:
        """Set/update entity."""
        ...
    
    @abstractmethod
    async def delete(self, key: str) -> None:
        """Delete entity."""
        ...
    
    async def get_or_create(
        self,
        key: str,
        factory: Callable[[], T],
    ) -> T:
        """Get or create entity."""
        existing = await self.get(key)
        if existing is not None:
            return existing
        
        entity = factory()
        await self.set(key, entity)
        return entity

