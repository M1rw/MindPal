# backend/services/rag_service.py

"""
RAG Service re-export module for backward compatibility.
Implementation moved to backend.services.domain.rag.
"""

from __future__ import annotations

from backend.services.domain.rag import (
    GroundingUnit,
    PreparedSearchTerm,
    RAGQueryPlan,
    RAGRetrievalResult,
    RAGService,
    RetrievalMatch,
)

__all__ = [
    "GroundingUnit",
    "PreparedSearchTerm",
    "RAGQueryPlan",
    "RAGRetrievalResult",
    "RAGService",
    "RetrievalMatch",
]
