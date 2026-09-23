from __future__ import annotations

from backend.core.contract import iter_operations
from backend.http.drift import drift_report
from backend.main import create_app


def test_voice_http_operations_have_zero_openapi_drift() -> None:
    report = drift_report(create_app(serve_frontend=False))

    assert report["ok"], report


def test_all_voice_contract_operations_are_declared() -> None:
    operations = {
        operation["operation_id"]
        for operation in iter_operations()
        if operation["path"].startswith("/api/voice/")
    }

    assert operations == {
        "voiceGetUsage",
        "voiceGetSessionAnalytics",
        "voiceGetSessionAudit",
        "voiceCreateSessionToken",
        "voiceRecordSessionEvent",
        "voiceSubmitTrace",
        "voiceClassifyReaction",
        "voiceRecall",
        "voiceSummarizeSession",
    }