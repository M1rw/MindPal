# tests/backend/chat/test_quota_refund_windows.py - a refund never reaches into a later window
"""Audit MP-25: a turn reserved in one 5-hour window and refunded after the
window rolled over subtracted its credit from the new window, erasing a later
successful turn's charge."""

from __future__ import annotations

from backend.domain.quota.quota import WINDOW_5H_SECONDS, QuotaService
from backend.infra.store.providers.memory import InMemoryStore

USER = "usr_window_edge"


class _Clock(QuotaService):
    now = 1_900_000_000.0

    def _now(self) -> float:
        return self.now


def test_an_old_window_refund_leaves_the_new_window_alone() -> None:
    quota = _Clock(InMemoryStore())
    old = quota.reserve(USER, 1)
    assert old.allowed
    quota.now += WINDOW_5H_SECONDS + 10  # the 5-hour window rolls over
    new = quota.reserve(USER, 1)
    assert new.allowed and new.credits_5h == 1
    quota.refund_quota(USER, 1, reservation=old)  # the old turn fails late
    assert quota.snapshot(USER).credits_5h == 1, "new window's charge was erased"
    # The weekly window did not roll over, so the old turn's weekly credit comes back.
    assert quota.snapshot(USER).credits_week == 1


def test_a_same_window_refund_still_gives_the_credit_back() -> None:
    quota = _Clock(InMemoryStore())
    decision = quota.reserve(USER, 2)
    quota.refund_quota(USER, 2, reservation=decision)
    snap = quota.snapshot(USER)
    assert snap.credits_5h == 0 and snap.credits_week == 0
