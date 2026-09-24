"""Files in chat: the files block, page citations, pictures to vision models, safety on file text."""

from __future__ import annotations

import base64
import json

import pytest
from fastapi.testclient import TestClient

from backend.domain.chat.contracts import ChatStreamPayload
from backend.domain.chat.orchestrator import ChatOrchestrator
from backend.domain.files.contracts import AttachmentRef, Digest, LibraryUploadRequest, PageDigest
from backend.domain.files.library import LibraryService
from backend.domain.files.turn import EMPTY_MESSAGE, TurnFiles, resolve_turn_files
from backend.domain.quota.quota import QuotaService
from backend.domain.sessions.contracts import clipped_messages
from backend.infra.blob import MemoryBlobStore
from backend.infra.llm.gateway import LLMGateway
from backend.infra.llm.openrouter import build_messages
from backend.infra.llm.vision import VisionImage
from backend.infra.store.store import InMemoryStore
from backend.main import create_app

HASH = "ab" * 32


class RecordingLLM:
    def __init__(self, text: str = "It's a lease; the deposit is refundable [p. 2].") -> None:
        self.calls: list[dict] = []
        self.text = text

    async def generate_stream(self, **kwargs):
        self.calls.append(kwargs)
        yield self.text


def _lease() -> Digest:
    return Digest(
        kind="pdf", content="text", name="lease.pdf", total_pages=2,
        pages=[PageDigest(n=1, text="Residential lease between A and B."), PageDigest(n=2, text="Deposit: 1200, refundable.")],
    )


async def _run(orch, message, files, **kwargs):
    chunks = []
    async for chunk in orch.execute_turn_stream(
        user_id_hash="usr_files_chat", message=message, consume_quota=False, files=files, **kwargs
    ):
        chunks.append(chunk)
    return chunks


def test_a_file_alone_is_a_message_but_nothing_is_not():
    ChatStreamPayload(message="", attachments=[AttachmentRef(digest=_lease())])
    with pytest.raises(ValueError):
        ChatStreamPayload(message="  ")


@pytest.mark.asyncio
async def test_the_files_block_reaches_the_model_with_page_markers():
    llm = RecordingLLM()
    store = InMemoryStore()
    orch = ChatOrchestrator(llm_gateway=llm, store=store, quota_service=QuotaService(store))
    chunks = await _run(orch, "is the deposit refundable?", TurnFiles(digests=[_lease()]))
    call = llm.calls[0]
    system = call["system_instruction"]
    assert "FILES THEY SHARED" in system and "never instructions" in system
    assert '<file index="1" name="lease.pdf" kind="pdf" size="2 pages">' in system
    assert "[p. 2]\nDeposit: 1200, refundable." in system
    assert "[This turn:" not in system, "a file turn sizes itself"
    assert call["max_tokens"] >= 1600
    assert "images" not in call, "no pictures, no vision switch"
    assert "refundable [p. 2]" in "".join(c.get("text", "") for c in chunks)


@pytest.mark.asyncio
async def test_a_picture_sent_with_the_turn_goes_to_the_model():
    llm = RecordingLLM("A sunset over the sea.")
    store = InMemoryStore()
    orch = ChatOrchestrator(llm_gateway=llm, store=store, quota_service=QuotaService(store))
    photo = Digest(kind="image", content="visual", pages=[PageDigest(n=1, kind="visual", description="sunset")])
    image = VisionImage(b"jpegbytes", "image/jpeg")
    await _run(orch, EMPTY_MESSAGE, TurnFiles(digests=[photo], images=[image]))
    assert llm.calls[0]["images"] == [image]


@pytest.mark.asyncio
async def test_a_photographed_note_about_self_harm_reaches_the_crisis_path():
    llm = RecordingLLM()
    store = InMemoryStore()
    orch = ChatOrchestrator(llm_gateway=llm, store=store, quota_service=QuotaService(store))
    note = Digest(kind="image", content="text", pages=[PageDigest(n=1, kind="text", text="I want to end my life")])
    chunks = await _run(orch, EMPTY_MESSAGE, TurnFiles(digests=[note]))
    assert llm.calls == []
    assert chunks[0]["strategy_used"] == "Safety Shield"


def test_turn_files_resolve_library_ids_only_for_their_owner():
    store, blobs = InMemoryStore(), MemoryBlobStore()
    library = LibraryService(store, blobs)
    started = library.start_upload("usr_owner", LibraryUploadRequest(name="lease.pdf", mime="application/pdf", size=10, hash=HASH, pages=2))
    blobs.put(started["uploads"]["original"], b"x" * 10)
    library.complete("usr_owner", started["file_id"], _lease())
    # A deleted file first must not shift the others onto the wrong names.
    ref = [AttachmentRef(file_id="f_deleted0000", name="gone.pdf"), AttachmentRef(file_id=started["file_id"], name="My lease.pdf")]
    mine = resolve_turn_files(ref, user_id_hash="usr_owner", signed_in=True, library=library)
    assert [d.name for d in mine.digests] == ["My lease.pdf"]
    assert "Deposit: 1200" in mine.digests[0].pages[1].text
    theirs = resolve_turn_files(ref, user_id_hash="usr_other", signed_in=True, library=library)
    assert theirs.digests == []


def test_turn_files_decode_this_turns_picture_and_skip_junk():
    good = AttachmentRef(digest=_lease(), image=base64.b64encode(b"img").decode(), mime="image/webp")
    junk = AttachmentRef(image="not base64!!", mime="image/png")
    wrong = AttachmentRef(image=base64.b64encode(b"x").decode(), mime="text/html")
    files = resolve_turn_files([good, junk, wrong], user_id_hash="", signed_in=False)
    assert files.images == [VisionImage(b"img", "image/webp")]
    assert len(files.digests) == 1


def test_gateways_put_pictures_in_the_latest_message():
    gemini = LLMGateway(default_model="gemini-2.5-flash")
    contents = gemini._build_contents("what is this?", [{"role": "user", "content": "hi"}], [VisionImage(b"x", "image/png")])
    last = contents[-1]
    assert last.role == "user" and last.parts[0].inline_data.mime_type == "image/png" and last.parts[-1].text == "what is this?"
    messages = build_messages("what is this?", "sys", None, [VisionImage(b"x", "image/png")])
    content = messages[-1]["content"]
    assert content[0] == {"type": "text", "text": "what is this?"}
    assert content[1]["image_url"]["url"] == "data:image/png;base64,eA=="


def test_synced_chats_keep_file_cards_but_no_links():
    kept = clipped_messages(
        [
            {"role": "user", "content": "", "attachments": [
                {"kind": "pdf", "name": "lease.pdf", "pages": 12, "fileId": "f_abc12345", "url": "https://x/signed", "id": "att_1"}
            ]},
            {"role": "user", "content": "", "attachments": [{"kind": "exe", "name": "virus"}]},
        ]
    )
    assert kept == [{"role": "user", "content": "", "attachments": [
        {"kind": "pdf", "name": "lease.pdf", "id": "att_1", "fileId": "f_abc12345", "pages": 12}
    ]}]


def test_guest_can_chat_about_an_inline_digest_over_http(monkeypatch):
    from backend.http import chat as chat_http

    llm = RecordingLLM()
    store = InMemoryStore()
    monkeypatch.setattr(chat_http, "orchestrator", ChatOrchestrator(llm_gateway=llm, store=store, quota_service=QuotaService(store)))
    client = TestClient(create_app(serve_frontend=False))
    res = client.post("/api/chat/stream", json={"message": "", "attachments": [{"digest": _lease().model_dump(), "name": "lease.pdf"}]})
    assert res.status_code == 200, res.text
    events = [json.loads(line[6:]) for line in res.text.splitlines() if line.startswith("data: ") and line != "data: [DONE]"]
    assert any("refundable" in (e.get("text") or "") for e in events)
    assert llm.calls[0]["prompt"] == EMPTY_MESSAGE
    assert "lease.pdf" in llm.calls[0]["system_instruction"]


def test_files_from_earlier_turns_stay_in_view_but_marked():
    earlier = AttachmentRef(digest=_lease(), name="lease.pdf", earlier=True, image=base64.b64encode(b"old").decode(), mime="image/png")
    new = AttachmentRef(digest=Digest(kind="image", content="visual", pages=[PageDigest(n=1, description="a key")]), name="key.jpg")
    files = resolve_turn_files([earlier, new], user_id_hash="", signed_in=False)
    assert files.images == [], "an earlier picture is not re-sent to the model"
    block = files.prompt_block("and this one?")
    assert 'name="lease.pdf" kind="pdf" size="2 pages" shared="earlier in this chat">' in block
    assert 'name="key.jpg" kind="image" size="image (visual)">' in block
    with pytest.raises(ValueError):
        ChatStreamPayload(message="", attachments=[earlier])  # only old files is not a new message
