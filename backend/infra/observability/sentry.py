"""Error reporting to Sentry, with MindPal's privacy rules applied first.

Off unless SENTRY_DSN is set, so local runs, tests and forks send nothing.

MindPal handles mental-health conversations, so the defaults are the strict
ones: no request bodies, no headers or cookies, no user identity, no local
variables from stack frames. Events carry the stack trace, route, status, the
release (git commit) and the request id, which is enough to find the matching
log line in Vercel. `scrub_event` is the last line of defence and runs on every
event before it leaves the process.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from backend.configs.settings import get_settings

logger = logging.getLogger("mindpal.sentry")

_DROPPED_REQUEST_KEYS = ("data", "cookies", "headers", "query_string", "env")
_SCRUBBED_EXTRA_KEYS = ("message", "text", "prompt", "content", "transcript", "body")
# Probes and the cron auth check are expected noise, not failures.
_IGNORED_LOGGERS = ("mindpal.pulse",)


def scrub_event(event: dict[str, Any], hint: dict[str, Any] | None = None) -> dict[str, Any] | None:
    request = event.get("request")
    if isinstance(request, dict):
        for key in _DROPPED_REQUEST_KEYS:
            request.pop(key, None)
        url = request.get("url")
        if isinstance(url, str) and "?" in url:
            request["url"] = url.split("?", 1)[0]
    event.pop("user", None)
    event.pop("server_name", None)
    extra = event.get("extra")
    if isinstance(extra, dict):
        for key in list(extra):
            if key.lower() in _SCRUBBED_EXTRA_KEYS:
                extra[key] = "[scrubbed]"
    if event.get("logger") in _IGNORED_LOGGERS:
        return None
    return event


def scrub_breadcrumb(crumb: dict[str, Any], hint: dict[str, Any] | None = None) -> dict[str, Any] | None:
    # HTTP breadcrumbs include the full URL of calls to Supabase and the LLM
    # providers; keep the method and status, drop the query string and payloads.
    data = crumb.get("data")
    if isinstance(data, dict):
        url = data.get("url")
        if isinstance(url, str) and "?" in url:
            data["url"] = url.split("?", 1)[0]
        data.pop("http.query", None)
        data.pop("body", None)
    if crumb.get("category") == "console":
        return None
    return crumb


def _sample_rate(raw: str) -> float:
    try:
        return min(1.0, max(0.0, float(raw)))
    except ValueError:
        return 0.0


def init_sentry() -> bool:
    """Start Sentry when configured. Never raises: monitoring must not take the app down."""
    settings = get_settings()
    dsn = settings.sentry_dsn.get_secret_value().strip()
    if not dsn:
        return False
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.logging import LoggingIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration
        from sentry_sdk.transport import HttpTransport

        class FlushingTransport(HttpTransport):
            """Serverless instances freeze right after the response, which would
            strand queued events. Errors are rare, so wait briefly for each."""

            def capture_envelope(self, envelope: Any) -> None:
                super().capture_envelope(envelope)
                self.flush(timeout=2.0)

        sentry_sdk.init(
            dsn=dsn,
            environment=settings.sentry_environment or ("production" if settings.is_production_environment() else "development"),
            release=settings.sentry_release or os.environ.get("VERCEL_GIT_COMMIT_SHA") or None,
            traces_sample_rate=_sample_rate(settings.sentry_traces_sample_rate),
            send_default_pii=False,
            include_local_variables=False,
            max_request_body_size="never",
            attach_stacktrace=True,
            before_send=scrub_event,
            before_breadcrumb=scrub_breadcrumb,
            transport=FlushingTransport,
            integrations=[
                StarletteIntegration(transaction_style="endpoint"),
                FastApiIntegration(transaction_style="endpoint"),
                # ERROR logs become events (storage_degraded_at_startup and the like);
                # lower levels stay breadcrumbs only.
                LoggingIntegration(level=logging.INFO, event_level=logging.ERROR),
            ],
        )
    except Exception:  # noqa: BLE001 - see docstring
        logger.warning("sentry_init_failed", exc_info=True)
        return False
    logger.info("sentry_enabled")
    return True


def tag_request(request_id: str) -> None:
    """Attach the request id so an event can be matched to its Vercel log line."""
    try:
        import sentry_sdk

        if sentry_sdk.is_initialized():
            sentry_sdk.set_tag("request_id", request_id)
    except Exception:  # noqa: BLE001
        pass


__all__ = ["init_sentry", "scrub_event", "scrub_breadcrumb", "tag_request"]
