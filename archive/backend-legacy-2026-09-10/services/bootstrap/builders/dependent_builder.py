"""
Dependent service builders (Memory, Safety, RAG, Output Guard, etc.).

These services depend on core services (particularly LLM).
Built after core services.
"""

from backend.core.config import Settings
from backend.services.configs import (
    MemoryServiceConfig,
    OutputGuardServiceConfig,
    SafetyServiceConfig,
)
from backend.services.domain.intelligence import ResponseIntelligenceService
from backend.services.domain.llm import LLMService
from backend.services.domain.memory import MemoryService
from backend.services.domain.rag import RAGService
from backend.services.domain.safety import SafetyService
from backend.services.output_guard_service import OutputGuardService


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
        config=MemoryServiceConfig.from_settings(
            settings,
            enable_llm_summarization=settings.ENABLE_LLM_MEMORY_SUMMARIZATION,
        ),
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
        settings=settings,
        llm_service=llm_service,
        config=OutputGuardServiceConfig.from_settings(
            settings,
            enable_llm_rewrite=settings.ENABLE_LLM_OUTPUT_REWRITE,
        ),
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
        settings=settings,
        enable_llm_planning=settings.ENABLE_LLM_RAG_PLANNING,
        allow_builtin_fallback_in_production=True,
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
        config=SafetyServiceConfig.from_settings(
            settings,
            enable_llm_ambiguity_classifier=settings.ENABLE_LLM_SAFETY_CLASSIFIER,
        ),
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
