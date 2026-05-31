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
        .replace('src="./demo.js"', 'src="/assets/demo.js"')
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
    history = payload.history

    if mode in {"companion", "chat"}:
        category = detect_distress_category(text)
        if category == "crisis":
            region = resolve_crisis_region(text, history=history, region_hint=payload.region)
            return {
                "mode": "crisis",
                "category": category,
                "region": region,
                "resource": build_resource_payload("crisis", region=region),
            }
        return {"mode": "chat", "result": run_chat(text, history=history)}

    if mode in {"cognitive tools", "cognitive_tools", "cognitive", "tool"}:
        lowered = text.casefold()
        if any(token in lowered for token in ("reality", "reframe", "distortion", "anxious thought")):
            return {"mode": "realitycheck", "result": run_realitycheck(text, history=history)}
        return {"mode": "unscramble", "result": run_unscramble(text, history=history)}

    if mode in {"resources", "resource"}:
        category = detect_distress_category(text)
        if category == "crisis":
            region = resolve_crisis_region(text, history=history, region_hint=payload.region)
            return {
                "mode": "crisis",
                "category": category,
                "region": region,
                "resource": build_resource_payload("crisis", region=region),
            }

        # Use AI to decide whether the user actually wants resources (language-aware)
        wants_resources = detect_resource_intent(text, history=payload.history)
        if wants_resources:
            category = category or "anxiety"
            return {
                "mode": "resources",
                "category": category,
                "resource": build_resource_payload(category),
            }

        # Otherwise treat it as a companion/chat message
        return {"mode": "chat", "result": run_chat(text, history=payload.history)}

    raise HTTPException(status_code=400, detail="Unsupported mode. Use Companion, Cognitive Tools, or Resources.")
