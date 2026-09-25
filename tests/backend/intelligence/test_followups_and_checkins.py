"""Dated follow-ups and opt-in check-in notifications."""

import base64
import json
from datetime import date, datetime, timezone

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

from backend.core.errors import AppError
from backend.domain.followups import askable_threads, due_threads, local_today
from backend.domain.memory.graph import MemoryGraph, MemoryGraphService
from backend.domain.notifications.service import COLLECTION, NotificationService
from backend.infra.push import webpush
from backend.infra.store.store import InMemoryStore
from backend.models.provider_outputs import MemorySummaryOutput

USER = "usr_checkin_owner"
FCM = "https://fcm.googleapis.com/fcm/send/device-a"
EXAM = "How did the Friday exam go?"
TRIP = "How was the trip to Jeddah?"
SLEEP = "Have you been sleeping any better?"


def graph(**after):
    return MemoryGraph(user_id_hash=USER, open_threads=[EXAM, TRIP, SLEEP], thread_after=after)


# -- dated threads ---------------------------------------------------------------


def test_summary_output_takes_dated_and_plain_threads():
    out = MemorySummaryOutput.model_validate({
        "summary": "Busy week.",
        "open_threads": [{"question": EXAM, "after": "2026-09-26"}, {"question": TRIP, "after": "soon"}, SLEEP],
    })
    assert out.open_threads == [EXAM, TRIP, SLEEP]
    assert out.thread_after == {EXAM: "2026-09-26"}, "only real dates"


def test_threads_wait_for_their_day_and_go_stale_after_a_week():
    g = graph(**{EXAM: "2026-09-26", TRIP: "2026-09-10"})
    assert askable_threads(g, date(2026, 9, 25)) == [SLEEP], "not before the exam; the trip is stale"
    assert due_threads(g, date(2026, 9, 26)) == [EXAM]
    assert askable_threads(g, date(2026, 9, 26)) == [EXAM, SLEEP], "due first"
    assert due_threads(g, date(2026, 10, 3)) == [], "a week later it is stale"


def test_the_graph_keeps_thread_dates_for_its_threads_only():
    store = InMemoryStore()
    service = MemoryGraphService(store=store)
    g = graph(**{EXAM: "2026-09-26", "Some old question?": "2026-01-01"})
    service.save_memory_graph(g)
    assert service.get_memory_graph(USER).thread_after == {EXAM: "2026-09-26"}


def test_local_today_uses_minutes_east_of_utc():
    late_utc = datetime(2026, 9, 25, 22, 30, tzinfo=timezone.utc)
    assert local_today(180, late_utc) == date(2026, 9, 26), "Riyadh is already tomorrow"
    assert local_today(-300, late_utc) == date(2026, 9, 25)


# -- web push --------------------------------------------------------------------


def _b64(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def test_vapid_token_verifies_with_the_public_key():
    private_key, public_key = webpush.generate_keys()
    header = webpush.vapid_authorization(FCM, private_key, "https://mindpal-demo.vercel.app", now=1_000_000)
    token = header.split("t=")[1].split(",")[0]
    key = header.split("k=")[1]
    assert key == public_key
    head, claims, signature = token.split(".")
    assert json.loads(_b64(claims)) == {"aud": "https://fcm.googleapis.com", "exp": 1_000_000 + webpush.TTL_SECONDS, "sub": "https://mindpal-demo.vercel.app"}
    raw = _b64(signature)
    der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
    public = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), _b64(public_key))
    public.verify(der, f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256()))  # raises if invalid


@pytest.mark.parametrize(
    ("endpoint", "ok"),
    [
        (FCM, True),
        ("https://web.push.apple.com/abc", True),
        ("https://updates.push.services.mozilla.com/wpush/v2/x", True),
        ("http://fcm.googleapis.com/x", False),
        ("https://169.254.169.254/latest", False),
        ("https://fcm.googleapis.com.evil.example/x", False),
        ("https://evil.example/fcm.googleapis.com", False),
        ("https://fcm.googleapis.com:8443/x", False),
    ],
)
def test_only_known_push_services(endpoint, ok):
    assert webpush.allowed_endpoint(endpoint) is ok


# -- notifications -----------------------------------------------------------------


class Sender:
    def __init__(self, gone=()):
        self.sent = []
        self.gone = set(gone)

    def __call__(self, endpoint, private_key, subject):
        if endpoint in self.gone:
            raise webpush.PushGone("410")
        self.sent.append(endpoint)


@pytest.fixture()
def world(monkeypatch):
    private_key, _ = webpush.generate_keys()
    monkeypatch.setattr(NotificationService, "_private_key", staticmethod(lambda: private_key))
    store = InMemoryStore()
    MemoryGraphService(store=store).save_memory_graph(graph(**{EXAM: "2026-09-26"}))
    return store


def service(store, sender, when):
    return NotificationService(store=store, send=sender, clock=lambda: when.timestamp())


RIYADH_AFTERNOON = datetime(2026, 9, 26, 12, 0, tzinfo=timezone.utc)  # 15:00 in UTC+3


def test_a_due_follow_up_sends_one_nudge_in_the_daytime(world):
    sender = Sender()
    svc = service(world, sender, RIYADH_AFTERNOON)
    svc.subscribe(USER, FCM, tz_offset=180, lang="ar")
    assert svc.run_daily()["sent"] == 1 and sender.sent == [FCM]
    assert svc.run_daily()["sent"] == 0, "never twice for the same question, nor twice a day"


def test_nothing_before_the_day_at_night_or_without_a_due_thread(world):
    sender = Sender()
    before = datetime(2026, 9, 25, 12, 0, tzinfo=timezone.utc)
    night = datetime(2026, 9, 26, 20, 0, tzinfo=timezone.utc)  # 23:00 in Riyadh
    for when in (before, night):
        svc = service(world, sender, when)
        svc.subscribe(USER, FCM, tz_offset=180, lang="ar")
        svc.run_daily()
    assert sender.sent == []


def test_dead_subscriptions_are_dropped(world):
    sender = Sender(gone={FCM})
    svc = service(world, sender, RIYADH_AFTERNOON)
    svc.subscribe(USER, FCM, tz_offset=180, lang="en")
    assert svc.run_daily()["gone"] == 1
    assert list(world.iter_documents(COLLECTION, prefix=f"{USER}:")) == []


def test_subscribe_refuses_unknown_endpoints_guests_and_extra_devices(world):
    svc = service(world, Sender(), RIYADH_AFTERNOON)
    with pytest.raises(AppError):
        svc.subscribe(USER, "https://evil.example/push", tz_offset=0, lang="en")
    with pytest.raises(AppError):
        svc.subscribe("guest_device", FCM, tz_offset=0, lang="en")
    for i in range(7):
        svc.subscribe(USER, f"{FCM}-{i}", tz_offset=0, lang="en")
    assert svc.status(USER)["devices"] == 5, "the oldest device makes room"
    svc.unsubscribe(USER, f"{FCM}-6")
    assert svc.status(USER)["devices"] == 4


def test_without_keys_nothing_is_offered_or_sent(monkeypatch):
    monkeypatch.setattr(NotificationService, "_private_key", staticmethod(lambda: ""))
    svc = NotificationService(store=InMemoryStore(), send=Sender())
    assert svc.status(USER)["available"] is False
    assert svc.run_daily()["sent"] == 0


def test_daily_endpoint_needs_the_scheduler_secret():
    from fastapi.testclient import TestClient

    from backend.main import create_app

    client = TestClient(create_app(serve_frontend=False))
    assert client.get("/api/internal/daily").status_code == 401
