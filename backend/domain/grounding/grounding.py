# backend/domain/grounding/grounding.py — RAG Corpus Grounding Domain

from __future__ import annotations

from dataclasses import dataclass
from typing import List


@dataclass(frozen=True, slots=True)
class GroundingChunk:
    id: str
    topic: str
    content: str


class GroundingService:
    """RAG Corpus Retrieval Service."""

    def retrieve_context(self, message: str, limit: int = 2) -> List[GroundingChunk]:
        # Clean bounded clinical grounding retrieval
        if not message:
            return []

        lower_msg = message.lower()
        chunks = []
        if any(w in lower_msg for w in ["anxious", "anxiety", "panic", "worried"]):
            chunks.append(
                GroundingChunk(
                    id="grounding_anxiety_54321",
                    topic="Grounding Technique (5-4-3-2-1)",
                    content="Acknowledge 5 things you can see, 4 things you can touch, 3 things you can hear, 2 things you can smell, and 1 thing you can taste.",
                )
            )
        if any(w in lower_msg for w in ["sad", "depressed", "hopeless", "down"]):
            chunks.append(
                GroundingChunk(
                    id="grounding_cbt_reframing",
                    topic="CBT Thought Reframing",
                    content="Identify automatic cognitive distortions (e.g. all-or-nothing thinking), evaluate evidence, and construct a balanced alternative thought.",
                )
            )
        return chunks[:limit]
