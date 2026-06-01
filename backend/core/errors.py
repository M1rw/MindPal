from fastapi import Request, status
from fastapi.responses import JSONResponse
import logging

logger = logging.getLogger("mindpal")

class MindPalException(Exception):
    def __init__(self, message: str, status_code: int = status.HTTP_500_INTERNAL_SERVER_ERROR):
        self.message = message
        self.status_code = status_code

async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Global exception: {str(exc)}", exc_info=True)
    status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
    message = "Internal Server Error"
    
    if isinstance(exc, MindPalException):
        status_code = exc.status_code
        message = exc.message

    return JSONResponse(
        status_code=status_code,
        content={"error": message}
    )