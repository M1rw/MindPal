from __future__ import annotations

from typing import Any

import httpx

from backend.core.errors import DatabaseError
from backend.core.security import sanitize_text


MAX_ERROR_CHARS = 300


class SupabaseClient:
    """Small server-only adapter for Supabase's PostgREST API.

    Firebase remains the identity provider. This client uses a service-role key
    only inside the backend and never exposes it to browser code or error text.
    """

    def __init__(
        self,
        *,
        base_url: str,
        service_role_key: str,
        http_client: httpx.AsyncClient,
    ) -> None:
        clean_url = str(base_url or "").strip().rstrip("/")
        clean_key = str(service_role_key or "").strip()
        if not clean_url or not clean_key:
            raise ValueError("Supabase URL and service-role key are required")
        self.base_url = clean_url
        self._service_role_key = clean_key
        self._http_client = http_client

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        payload: dict[str, Any] | None = None,
        prefer: str | None = None,
    ) -> httpx.Response:
        headers = {
            "Accept": "application/json",
            "apikey": self._service_role_key,
            "Authorization": f"Bearer {self._service_role_key}",
        }
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if prefer:
            headers["Prefer"] = prefer

        try:
            response = await self._http_client.request(
                method,
                f"{self.base_url}{path}",
                params=params,
                json=payload,
                headers=headers,
            )
        except httpx.HTTPError as exc:
            raise DatabaseError(
                "Supabase request failed",
                code="supabase_request_failed",
            ) from exc

        if response.is_error:
            raise DatabaseError(
                "Supabase request was rejected",
                code="supabase_request_rejected",
                details={"status_code": response.status_code},
            )
        return response

    @staticmethod
    def decode_json(response: httpx.Response) -> Any:
        try:
            return response.json()
        except ValueError as exc:
            raise DatabaseError(
                "Supabase returned invalid JSON",
                code="supabase_invalid_response",
                details={"response": sanitize_text(response.text, MAX_ERROR_CHARS)},
            ) from exc
