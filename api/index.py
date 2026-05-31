from __future__ import annotations

import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# Ensure imports work in Vercel/runtime
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.web.demo_logic import (  # noqa: E402
    build_resource_payload,
    detect_distress_category,
    detect_resource_intent,
    resolve_crisis_region,
    run_chat,
    run_realitycheck,
    run_unscramble,
)
from src.web.session_memory import SessionMemoryStore  # noqa: E402
from src.utils.config import RESOURCE_OPTIONS  # noqa: E402


class TextRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


class CategoryRequest(BaseModel):
    category: str = Field(min_length=1, max_length=32)


class AskRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    mode: str = Field(min_length=1, max_length=64)
    history: list[dict[str, str]] = Field(default_factory=list)
    region: str | None = Field(default=None, max_length=32)
    sessionId: str | None = Field(default=None, max_length=128)


class SessionRequest(BaseModel):
    session_id: str = Field(min_length=8, max_length=128)


session_store = SessionMemoryStore()


def _normalize_history(history: list[dict[str, str]]) -> list[dict[str, str]]:
    cleaned: list[dict[str, str]] = []
    for item in history:
        role = str(item.get("role", "")).strip().lower()
        text = str(item.get("text", "")).strip()
        if role not in {"user", "assistant"}:
            continue
        if not text:
            continue
        cleaned.append({"role": role, "text": text[:4000]})

    return cleaned[-64:]


def _resolve_history_for_request(session_id: str | None, incoming_history: list[dict[str, str]]) -> list[dict[str, str]]:
    normalized_incoming = _normalize_history(incoming_history)
    if not session_id:
        return normalized_incoming

    stored_history = session_store.get_history(session_id)
    if len(normalized_incoming) >= len(stored_history):
        return normalized_incoming
    return stored_history


def _ensure_latest_user_turn(history: list[dict[str, str]], text: str) -> list[dict[str, str]]:
    cleaned_text = text.strip()
    if not cleaned_text:
        return history

    if history and history[-1].get("role") == "user" and history[-1].get("text", "").strip() == cleaned_text:
        return history

    return [*history, {"role": "user", "text": cleaned_text}]


app = FastAPI(title="MindPal Web Demo", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/assets", StaticFiles(directory=ROOT / "src" / "assets"), name="assets")


@app.get("/", response_class=HTMLResponse)
def home() -> str:
    html_path = ROOT / "src" / "assets" / "demo.html"
    if not html_path.exists():
        raise HTTPException(status_code=500, detail="demo.html is missing")
    html = html_path.read_text(encoding="utf-8")
    return (
        html.replace('src="./img/logo.jpg"', 'src="/assets/img/logo.jpg"')
        .replace('href="./demo.css"', 'href="/assets/demo.css"')
        .replace('src="./js/core.js"', 'src="/assets/js/core.js"')
        .replace('src="./js/chat.js"', 'src="/assets/js/chat.js"')
    )


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/categories")
def categories() -> dict[str, list[dict[str, str]]]:
    values = [
        {"label": label, "value": value, "description": description}
        for label, value, description in RESOURCE_OPTIONS
    ]
    return {"categories": values}


@app.post("/api/classify")
def classify(payload: TextRequest) -> dict[str, str | None]:
    category = detect_distress_category(payload.text)
    return {"category": category}


@app.get("/api/resources/{category}")
def resources(category: str) -> dict[str, object]:
    result = build_resource_payload(category)
    return result


@app.post("/api/unscramble")
def unscramble(payload: TextRequest) -> dict[str, str]:
    return {"result": run_unscramble(payload.text)}


@app.post("/api/realitycheck")
def realitycheck(payload: TextRequest) -> dict[str, str]:
    return {"result": run_realitycheck(payload.text)}


@app.post("/api/session/clear")
def clear_session(payload: SessionRequest) -> dict[str, object]:
    session_id = payload.session_id.strip()
    was_present = session_store.clear(session_id)
    return {"session_id": session_id, "cleared": was_present}


@app.get("/api/session/export")
def export_session(session_id: str) -> dict[str, object]:
    sid = session_id.strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id is required")
    return session_store.export(sid)


@app.post("/api/chat")
def chat(payload: TextRequest) -> dict[str, str | dict[str, object]]:
    category = detect_distress_category(payload.text)
    if category == "crisis":
        return {
            "mode": "crisis",
            "category": category,
            "resource": build_resource_payload("crisis"),
        }

    return {
        "mode": "chat",
        "result": run_chat(payload.text),
    }


@app.post("/api/ask")
def ask(payload: AskRequest) -> dict[str, object]:
    mode = payload.mode.strip().casefold()
    text = payload.text
    session_id = (payload.sessionId or "").strip() or None
    history = _resolve_history_for_request(session_id, payload.history)
    history_for_model = _ensure_latest_user_turn(history, text)

    if session_id:
        session_store.replace_history(session_id, history_for_model)

    if mode in {"companion", "chat"}:
        category = detect_distress_category(text)
        if category == "crisis":
            region = resolve_crisis_region(text, history=history_for_model, region_hint=payload.region)
            response = {
                "mode": "crisis",
                "category": category,
                "region": region,
                "resource": build_resource_payload("crisis", region=region),
            }
            if session_id:
                session_store.append_turn(session_id, "assistant", response["resource"]["markdown"])
            return response

        response = {"mode": "chat", "result": run_chat(text, history=history_for_model)}
        if session_id:
            session_store.append_turn(session_id, "assistant", str(response["result"]))
        return response

    if mode in {"cognitive tools", "cognitive_tools", "cognitive", "tool"}:
        lowered = text.casefold()
        if any(token in lowered for token in ("reality", "reframe", "distortion", "anxious thought")):
            response = {"mode": "realitycheck", "result": run_realitycheck(text, history=history_for_model)}
            if session_id:
                session_store.append_turn(session_id, "assistant", str(response["result"]))
            return response

        response = {"mode": "unscramble", "result": run_unscramble(text, history=history_for_model)}
        if session_id:
            session_store.append_turn(session_id, "assistant", str(response["result"]))
        return response

    if mode in {"resources", "resource"}:
        category = detect_distress_category(text)
        if category == "crisis":
            region = resolve_crisis_region(text, history=history_for_model, region_hint=payload.region)
            response = {
                "mode": "crisis",
                "category": category,
                "region": region,
                "resource": build_resource_payload("crisis", region=region),
            }
            if session_id:
                session_store.append_turn(session_id, "assistant", response["resource"]["markdown"])
            return response

        # Use AI to decide whether the user actually wants resources (language-aware)
        wants_resources = detect_resource_intent(text, history=history_for_model)
        if wants_resources:
            category = category or "anxiety"
            response = {
                "mode": "resources",
                "category": category,
                "resource": build_resource_payload(category),
            }
            if session_id:
                session_store.append_turn(session_id, "assistant", response["resource"]["markdown"])
            return response

        # Otherwise treat it as a companion/chat message
        response = {"mode": "chat", "result": run_chat(text, history=history_for_model)}
        if session_id:
            session_store.append_turn(session_id, "assistant", str(response["result"]))
        return response

    raise HTTPException(status_code=400, detail="Unsupported mode. Use Companion, Cognitive Tools, or Resources.")
