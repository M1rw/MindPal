from fastapi import APIRouter
from backend.core.config import settings

router = APIRouter()

@router.get("/")
@router.get("/health")
async def health_check():
    return {
        "status": "ok",
        "project": settings.PROJECT_NAME,
        "version": settings.VERSION,
        "environment": settings.ENVIRONMENT
    }