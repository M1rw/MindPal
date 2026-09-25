"""Composer dictation: any language, mixed languages, bounded cost."""

from __future__ import annotations

import pytest

from backend.core.errors import AppError
from backend.domain.dictation import service as dictation
from backend.infra.llm import transcribe
from backend.infra.store.store import InMemoryStore


class FakeGroq:
    """Stands in for Whisper: answers by the prompt it is given, like the real one did."""

    def __init__(self, language: str, plain: str, mixed: str = "") -> None:
        self.language, self.plain, self.mixed = language, plain, mixed
        self.prompts: list[str] = []

    def __call__(self, audio: bytes, content_type: str, prompt: str) -> transcribe.Transcript:
        self.prompts.append(prompt)
        text = self.mixed if prompt else self.plain
        return transcribe.Transcript(text=text, language=self.language, provider="groq")


def test_english_is_one_pass_and_needs_no_prompt(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeGroq("english", "I feel stuck.")
    monkeypatch.setattr(transcribe, "_groq_pass", fake)
    assert transcribe._via_groq(b"x", "audio/webm").text == "I feel stuck."
    assert fake.prompts == [""]


def test_arabic_gets_a_second_pass_that_keeps_mixed_words_in_their_script(monkeypatch: pytest.MonkeyPatch) -> None:
    # Measured on real audio: without a prompt, "my manager" came back as "مي مانجر".
    fake = FakeGroq("arabic", "حسناً، اليوم كان متعب. مي مانجر", "Honestly, اليوم كان متعب. My manager")
    monkeypatch.setattr(transcribe, "_groq_pass", fake)
    result = transcribe._via_groq(b"x", "audio/webm")
    assert result.text == "Honestly, اليوم كان متعب. My manager"
    assert fake.prompts[0] == "" and fake.prompts[1] == transcribe._MIXED_PROMPTS["arabic"]


def test_other_languages_keep_the_first_pass(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeGroq("spanish", "Hoy fue un día largo.")
    monkeypatch.setattr(transcribe, "_groq_pass", fake)
    assert transcribe._via_groq(b"x", "audio/webm").text == "Hoy fue un día largo."
    assert len(fake.prompts) == 1


def _service(monkeypatch: pytest.MonkeyPatch, *, now: float = 7200.0) -> dictation.DictationService:
    monkeypatch.setattr(dictation, "transcription_available", lambda: True)
    monkeypatch.setattr(
        dictation, "transcribe_audio", lambda audio, content_type, languages=(): transcribe.Transcript("hello", "english", "groq")
    )
    return dictation.DictationService(store=InMemoryStore(), clock=lambda: now)


def test_rejects_empty_oversized_and_non_audio(monkeypatch: pytest.MonkeyPatch) -> None:
    service = _service(monkeypatch)
    for audio, kind in ((b"", "audio/webm"), (b"x" * (dictation.MAX_AUDIO_BYTES + 1), "audio/webm"), (b"x", "text/html")):
        with pytest.raises(AppError) as err:
            service.transcribe(audio, kind, subject="usr_a", signed_in=True)
        assert err.value.code == "payload_invalid"


def test_hourly_allowance_per_subject(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(dictation._LIMITS, "per_hour_guest", 2)
    service = _service(monkeypatch)
    for _ in range(2):
        assert service.transcribe(b"x", "audio/webm", subject="peer:1.2.3.4", signed_in=False).text == "hello"
    with pytest.raises(AppError) as err:
        service.transcribe(b"x", "audio/webm", subject="peer:1.2.3.4", signed_in=False)
    assert err.value.code == "rate_limited"
    # Someone else, and the same person next hour, are unaffected.
    assert service.transcribe(b"x", "audio/webm", subject="peer:5.6.7.8", signed_in=False).text == "hello"
    later = dictation.DictationService(store=service.store, clock=lambda: 7200.0 + 3600)
    assert later.transcribe(b"x", "audio/webm", subject="peer:1.2.3.4", signed_in=False).text == "hello"


def test_provider_failure_is_a_clean_503(monkeypatch: pytest.MonkeyPatch) -> None:
    service = _service(monkeypatch)

    def boom(audio: bytes, content_type: str, languages: object = ()) -> transcribe.Transcript:
        raise transcribe.TranscriptionUnavailable("groq 429")

    monkeypatch.setattr(dictation, "transcribe_audio", boom)
    with pytest.raises(AppError) as err:
        service.transcribe(b"x", "audio/mp4", subject="usr_a", signed_in=True)
    assert err.value.code == "unavailable"


def test_route_takes_the_raw_body(monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient

    from backend.http import dictation as route
    from backend.main import create_app

    monkeypatch.setattr(route, "service", _service(monkeypatch))
    client = TestClient(create_app())
    ok = client.post("/api/transcribe", content=b"\x1a\x45\xdf\xa3", headers={"Content-Type": "audio/webm;codecs=opus"})
    assert ok.status_code == 200 and ok.json() == {"text": "hello", "language": "english"}
    bad = client.post("/api/transcribe", content=b"<html>", headers={"Content-Type": "text/html"})
    assert bad.status_code == 422


class Providers:
    """Both providers faked, recording which ran: Whisper keeps one language, Gemini keeps them all."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, whisper: transcribe.Transcript, *, groq: bool = True, gemini: bool = True, gemini_fails: bool = False) -> None:
        self.calls: list[str] = []
        self.whisper, self.gemini_fails = whisper, gemini_fails
        monkeypatch.setattr(transcribe, "groq_api_key", lambda: "k" if groq else "")
        settings = transcribe.get_settings()
        monkeypatch.setattr(type(settings), "resolved_gemini_api_key", lambda self: "k" if gemini else "", raising=False)
        monkeypatch.setattr(transcribe, "_groq_pass", self._groq)
        monkeypatch.setattr(transcribe, "_via_gemini", self._gemini)

    def _groq(self, audio: bytes, content_type: str, prompt: str) -> transcribe.Transcript:
        self.calls.append("whisper+prompt" if prompt else "whisper")
        return self.whisper

    def _gemini(self, audio: bytes, content_type: str) -> transcribe.Transcript:
        self.calls.append("gemini")
        if self.gemini_fails:
            raise transcribe.TranscriptionUnavailable("gemini 429")
        return transcribe.Transcript("Today was exhausting. اليوم كان متعب جدا.", "arabic", "gemini")


ENGLISH = transcribe.Transcript("Today was exhausting.", "english", "groq")
ARABIC_ONLY = transcribe.Transcript("اليوم كان متعب جدا.", "arabic", "groq")


def test_english_speakers_stay_on_fast_whisper(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = Providers(monkeypatch, ENGLISH)
    assert transcribe.transcribe_audio(b"x", "audio/webm", ["en-US", "en"]).text == "Today was exhausting."
    assert fake.calls == ["whisper"]


def test_english_first_then_arabic_is_not_cut_to_the_first_language(monkeypatch: pytest.MonkeyPatch) -> None:
    # The bug: Whisper heard English first and dropped the Arabic. Someone who
    # speaks Arabic (browser, setting, or earlier notes) goes straight to Gemini.
    fake = Providers(monkeypatch, ENGLISH)
    result = transcribe.transcribe_audio(b"x", "audio/webm", ["en-US", "ar"])
    assert result.text == "Today was exhausting. اليوم كان متعب جدا." and result.provider == "gemini"
    assert fake.calls == ["gemini"]


def test_whisper_hearing_another_language_hands_over_to_gemini(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = Providers(monkeypatch, ARABIC_ONLY)
    assert transcribe.transcribe_audio(b"x", "audio/webm", ["en-US"]).provider == "gemini"
    assert fake.calls == ["whisper", "gemini"]


def test_gemini_down_falls_back_to_whisper_with_the_mixed_prompt(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = Providers(monkeypatch, ARABIC_ONLY, gemini_fails=True)
    assert transcribe.transcribe_audio(b"x", "audio/webm", ["ar"]).provider == "groq"
    assert fake.calls == ["gemini", "whisper", "whisper+prompt"]


def test_without_gemini_whisper_does_it_all(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = Providers(monkeypatch, ARABIC_ONLY, gemini=False)
    assert transcribe.transcribe_audio(b"x", "audio/webm", ["ar"]).provider == "groq"
    assert fake.calls == ["whisper", "whisper+prompt"]


def test_language_hints_are_sanitised() -> None:
    from backend.http.dictation import language_hints

    assert language_hints("en-US, AR ,ar,<script>,fr-fr") == ["en-us", "ar", "fr-fr"]
    assert language_hints(None) == [] and len(language_hints(",".join(["ar"] * 50 + ["de"]))) == 1


def test_script_decides_the_reported_language() -> None:
    assert transcribe._script_language("Honestly, اليوم كان متعب") == "arabic"
    assert transcribe._script_language("I feel stuck") == "english"
    assert transcribe._script_language("") == ""
