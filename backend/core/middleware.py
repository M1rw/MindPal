from __future__ import annotations


from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class RequestBodyTooLargeError(Exception):
    pass


class RequestBodyLimitMiddleware:
    """Reject oversized HTTP bodies before framework parsing/validation.

    Both Content-Length and streamed/chunked bodies are enforced. This avoids
    allocating a large JSON/base64 payload before Pydantic can reject it.
    """

    def __init__(self, app: ASGIApp, *, max_body_bytes: int) -> None:
        self.app = app
        self.max_body_bytes = max(1, int(max_body_bytes))

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        raw_length = headers.get(b"content-length", b"")
        if raw_length:
            try:
                if int(raw_length) > self.max_body_bytes:
                    await self._reject(scope, receive, send)
                    return
            except ValueError:
                # Invalid Content-Length is handled by the ASGI server/framework.
                pass

        received = 0
        response_started = False

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message.get("type") == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_body_bytes:
                    raise RequestBodyTooLargeError
            return message

        async def tracked_send(message: Message) -> None:
            nonlocal response_started
            if message.get("type") == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracked_send)
        except RequestBodyTooLargeError:
            if response_started:
                raise
            await self._reject(scope, receive, send)

    async def _reject(self, scope: Scope, receive: Receive, send: Send) -> None:
        state = scope.get("state") or {}
        request_id = str(state.get("request_id") or "")
        content = {
            "code": "request_body_too_large",
            "message": "Request body exceeds the configured limit",
            "details": {"max_bytes": self.max_body_bytes},
        }
        if request_id:
            content["request_id"] = request_id
        response = JSONResponse(status_code=413, content=content)
        await response(scope, receive, send)
