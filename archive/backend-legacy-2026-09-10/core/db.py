# backend/core/db.py

"""
Database infrastructure primitives.

Provides abstract database connection management and session lifecycle interfaces
without embedding specific ORM or domain entity models.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncGenerator
from typing import Any

from backend.core.config import Settings, get_settings

logger = logging.getLogger("mindpal.db")


class DatabaseEngine:
    """Abstract database connection pool/engine wrapper."""

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()
        self._connected: bool = False

    async def connect(self) -> None:
        """Establish database connection pool if configured."""
        self._connected = True
        logger.debug("Database engine connected")

    async def disconnect(self) -> None:
        """Close database connection pool."""
        self._connected = False
        logger.debug("Database engine disconnected")

    @property
    def is_connected(self) -> bool:
        return self._connected


class DatabaseSession:
    """Abstract database transaction/session wrapper."""

    def __init__(self, engine: DatabaseEngine) -> None:
        self._engine = engine
        self._in_transaction: bool = False

    async def __aenter__(self) -> DatabaseSession:
        self._in_transaction = True
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: Any,
    ) -> None:
        self._in_transaction = False
        if exc_type is not None:
            await self.rollback()
        else:
            await self.commit()

    async def commit(self) -> None:
        """Commit current transaction."""
        pass

    async def rollback(self) -> None:
        """Roll back current transaction."""
        pass


_global_engine: DatabaseEngine | None = None


def get_db_engine(settings: Settings | None = None) -> DatabaseEngine:
    global _global_engine
    if _global_engine is None:
        _global_engine = DatabaseEngine(settings)
    return _global_engine


async def get_db_session() -> AsyncGenerator[DatabaseSession, None]:
    """FastAPI dependency yield for database sessions."""
    engine = get_db_engine()
    if not engine.is_connected:
        await engine.connect()
    async with DatabaseSession(engine) as session:
        yield session
