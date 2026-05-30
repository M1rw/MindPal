from __future__ import annotations

import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

# Ensure imports work in Vercel/runtime
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.web.demo_logic import (  # noqa: E402
    build_resource_payload,
    detect_distress_category,
    run_chat,
    run_realitycheck,
    run_unscramble,
)
from src.utils.config import RESOURCE_OPTIONS  # noqa: E402


class TextRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


class CategoryRequest(BaseModel):
    category: str = Field(min_length=1, max_length=32)


app = FastAPI(title="MindPal Web Demo", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/", response_class=HTMLResponse)
def home() -> str:
    html_path = ROOT / "src" / "assets" / "demo.html"
    if not html_path.exists():
        raise HTTPException(status_code=500, detail="demo.html is missing")
    return html_path.read_text(encoding="utf-8")


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
