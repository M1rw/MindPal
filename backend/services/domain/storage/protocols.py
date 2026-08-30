# Storage domain protocols

from typing import Any, Callable, Protocol


class StorageProvider(Protocol):
    """Storage provider contract."""

    name: str

    @property
    def is_configured(self) -> bool:
        ...

    async def get_document(self, collection: str, key: str) -> dict[str, Any] | None:
        ...

    async def set_document(self, collection: str, key: str, payload: dict[str, Any]) -> None:
        ...

    async def delete_document(self, collection: str, key: str) -> None:
        ...

    async def append_event(self, collection: str, payload: dict[str, Any]) -> str:
        ...

    async def atomic_update_document(
        self,
        collection: str,
        key: str,
        update_fn: Callable[[dict[str, Any]], dict[str, Any]],
    ) -> dict[str, Any]:
        ...
