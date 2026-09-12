# backend/features/flags/repo.py

"""
Feature policy repository protocols and implementations.
"""

from __future__ import annotations

import asyncio
from typing import Protocol

from .schemas import FeaturePolicy


class FeaturePolicyRepository(Protocol):
    async def get_policy(self, key: str) -> FeaturePolicy | None:
        ...

    async def get_all_policies(self) -> dict[str, FeaturePolicy]:
        ...

    async def set_policy(self, policy: FeaturePolicy) -> None:
        ...

    async def delete_policy(self, key: str) -> None:
        ...


class InMemoryFeaturePolicyRepository:
    """Thread-safe in-memory feature policy store."""

    def __init__(self) -> None:
        self._policies: dict[str, FeaturePolicy] = {}
        self._lock = asyncio.Lock()

    async def get_policy(self, key: str) -> FeaturePolicy | None:
        async with self._lock:
            return self._policies.get(key)

    async def get_all_policies(self) -> dict[str, FeaturePolicy]:
        async with self._lock:
            return dict(self._policies)

    async def set_policy(self, policy: FeaturePolicy) -> None:
        async with self._lock:
            self._policies[policy.key] = policy

    async def delete_policy(self, key: str) -> None:
        async with self._lock:
            self._policies.pop(key, None)
