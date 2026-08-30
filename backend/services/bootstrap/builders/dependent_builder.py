"""
Dependent service builders (Memory, Safety, RAG, Output Guard, etc.).

These services depend on core services (particularly LLM).
Built after core services.
"""

from backend.core.config import Settings
from backend.services import (
    LLMService,
    MemoryService,
    OutputGuardService,
    RAGService,
    SafetyService,
)
from backend.services.response_intelligence_service import ResponseIntelligenceService


def build_memory_service(settings: Settings, llm_service: LLMService) -> MemoryService:
    """
    Construct memory service with LLM dependency.

    Args:
        settings: Application settings
        llm_service: LLM service for memory operations

    Returns:
        MemoryService instance
    """
    return MemoryService(
        settings=settings,
        llm_service=llm_service,
        enable_llm_summarization=settings.ENABLE_LLM_MEMORY_SUMMARIZATION,
    )


def build_output_guard_service(
    llm_service: LLMService, settings: Settings
) -> OutputGuardService:
    """
    Construct output guard with LLM dependency.

    Args:
        llm_service: LLM service for guard operations
        settings: Application settings

    Returns:
        OutputGuardService instance
    """
    return OutputGuardService(
        llm_service=llm_service,
        enable_llm_rewrite=settings.ENABLE_LLM_OUTPUT_REWRITE,
    )


def build_rag_service(llm_service: LLMService, settings: Settings) -> RAGService:
    """
    Construct RAG service with LLM dependency.

    Args:
        llm_service: LLM service for RAG operations
        settings: Application settings

    Returns:
        RAGService instance
    """
    return RAGService(
        llm_service=llm_service,
        enable_llm_planning=settings.ENABLE_LLM_RAG_PLANNING,
    )


def build_safety_service(llm_service: LLMService, settings: Settings) -> SafetyService:
    """
    Construct safety service with LLM dependency.

    Args:
        llm_service: LLM service for safety operations
        settings: Application settings

    Returns:
        SafetyService instance
    """
    return SafetyService(
        settings=settings,
        llm_service=llm_service,
        enable_llm_ambiguity_classifier=settings.ENABLE_LLM_SAFETY_CLASSIFIER,
    )


def build_response_intelligence_service(
    settings: Settings, llm_service: LLMService
) -> ResponseIntelligenceService:
    """
    Construct response intelligence service.

    Args:
        settings: Application settings
        llm_service: LLM service for intelligence operations

    Returns:
        ResponseIntelligenceService instance
    """
    return ResponseIntelligenceService(settings=settings, llm_service=llm_service)
