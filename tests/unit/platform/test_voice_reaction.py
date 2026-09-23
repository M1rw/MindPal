"""The face's listening reaction: one label per phrase, any language, never fatal."""

from backend.domain.voice.services.reaction import MIN_INTERVAL_S, REACTIONS, VoiceReactionService


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def service(reply: str = '{"reaction": "smile"}', clock: Clock | None = None, calls: list | None = None):
    def generate(**kwargs):
        if calls is not None:
            calls.append(kwargs)
        if isinstance(reply, Exception):
            raise reply
        return reply

    return VoiceReactionService(generate_json=generate, clock=clock or Clock())


def test_returns_the_classifier_label():
    assert service('{"reaction": "concern"}').classify(user_id_hash="u", text="my dog died") == "concern"


def test_any_language_goes_to_the_model_untouched():
    calls: list = []
    service(calls=calls).classify(user_id_hash="u", text="نجحت في الامتحان أخيرا", context="كنت خايف")
    assert "نجحت في الامتحان أخيرا" in calls[0]["prompt"]
    assert "كنت خايف" in calls[0]["prompt"]


def test_unknown_or_broken_answers_become_none():
    assert service('{"reaction": "dance"}').classify(user_id_hash="u", text="hi") == "none"
    assert service("not json").classify(user_id_hash="u", text="hi") == "none"
    assert service(RuntimeError("provider down")).classify(user_id_hash="u", text="hi") == "none"


def test_empty_text_is_not_sent():
    calls: list = []
    assert service(calls=calls).classify(user_id_hash="u", text="   ") == "none"
    assert calls == []


def test_rate_limited_per_caller_without_erroring():
    clock = Clock()
    calls: list = []
    svc = service(clock=clock, calls=calls)
    assert svc.classify(user_id_hash="a", text="one") == "smile"
    assert svc.classify(user_id_hash="a", text="two") == "none", "too soon"
    assert svc.classify(user_id_hash="b", text="other caller") == "smile"
    clock.t += MIN_INTERVAL_S
    assert svc.classify(user_id_hash="a", text="three") == "smile"
    assert len(calls) == 3


def test_labels_are_the_face_vocabulary():
    assert set(REACTIONS) == {"smile", "laugh", "surprise", "concern", "tender", "excited", "curious", "none"}


def test_mindpal_speech_uses_the_speaking_prompt():
    calls: list = []
    service(calls=calls).classify(user_id_hash="u", text="Haha, wait, really?", speaker="mindpal")
    assert calls[0]["prompt"] == "MindPal is saying: Haha, wait, really?"
    assert "while MindPal itself is speaking" in calls[0]["system_instruction"]


def test_caller_speech_keeps_the_listening_prompt():
    calls: list = []
    service(calls=calls).classify(user_id_hash="u", text="I passed")
    assert "Just said: I passed" in calls[0]["prompt"]
    assert "The caller is still talking" in calls[0]["system_instruction"]
