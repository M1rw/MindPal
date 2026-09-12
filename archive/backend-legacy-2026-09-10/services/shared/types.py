# Shared types and constants

from typing import TypeVar, Generic, Optional, Any, Dict, Callable, Awaitable
from dataclasses import dataclass

T = TypeVar('T')
K = TypeVar('K')
V = TypeVar('V')


@dataclass(frozen=True)
class OperationResult:
    """Result of an operation."""
    success: bool
    message: str
    data: Optional[Any] = None
    errors: Optional[Dict[str, Any]] = None


@dataclass(frozen=True)
class PaginationParams:
    """Pagination parameters."""
    limit: int = 50
    offset: int = 0
    
    def validate(self) -> None:
        """Validate pagination params."""
        if self.limit < 1 or self.limit > 1000:
            raise ValueError("limit must be between 1 and 1000")
        if self.offset < 0:
            raise ValueError("offset must be >= 0")


@dataclass(frozen=True)
class PaginatedResult(Generic[T]):
    """Paginated result."""
    items: list[T]
    total: int
    limit: int
    offset: int
    
    @property
    def has_more(self) -> bool:
        return (self.offset + self.limit) < self.total


# Type aliases
ServiceFactory = Callable[[], Awaitable[Any]]
ProviderFactory = Callable[[], Any]
ValidationFn = Callable[[T], bool]

