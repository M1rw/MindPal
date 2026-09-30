"""Sentry is opt-in and must never carry conversation content or identity."""

from __future__ import annotations

from backend.infra.observability import sentry


def test_no_dsn_means_off(monkeypatch) -> None:
    monkeypatch.delenv("SENTRY_DSN", raising=False)
    assert sentry.init_sentry() is False


def test_scrub_event_drops_bodies_headers_user_and_query() -> None:
    event = {
        "request": {
            "url": "https://x.vercel.app/api/chat?q=secret",
            "data": {"message": "private"},
            "headers": {"Authorization": "Bearer t"},
            "cookies": {"a": "b"},
            "query_string": "q=secret",
        },
        "user": {"id": "u1", "email": "a@b.c"},
        "server_name": "host",
        "extra": {"message": "private", "route": "/api/chat"},
    }
    out = sentry.scrub_event(event)
    assert out is not None
    assert out["request"] == {"url": "https://x.vercel.app/api/chat"}
    assert "user" not in out and "server_name" not in out
    assert out["extra"] == {"message": "[scrubbed]", "route": "/api/chat"}


def test_scrub_breadcrumb_strips_query_and_console() -> None:
    crumb = {"category": "httplib", "data": {"url": "https://s.co/rest/v1/t?doc=1", "body": "x"}}
    out = sentry.scrub_breadcrumb(crumb)
    assert out["data"] == {"url": "https://s.co/rest/v1/t"}
    assert sentry.scrub_breadcrumb({"category": "console"}) is None


def test_bad_sample_rate_is_zero() -> None:
    assert sentry._sample_rate("nope") == 0.0
    assert sentry._sample_rate("5") == 1.0


def test_init_with_dsn_enables_and_scrubs(monkeypatch) -> None:
    import sentry_sdk

    monkeypatch.setenv("SENTRY_DSN", "https://key@o0.ingest.sentry.io/1")
    try:
        assert sentry.init_sentry() is True
        opts = sentry_sdk.get_client().options
        assert opts["send_default_pii"] is False
        assert opts["max_request_body_size"] == "never"
        assert opts["include_local_variables"] is False
    finally:
        sentry_sdk.get_client().close()
        sentry_sdk.init()  # back to a disabled client
