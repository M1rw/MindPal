import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from core.config import settings

# --- APPLICATION LIFECYCLE ---

# Initialize the FastAPI application with metadata from our configuration.
# This metadata populates the auto-generated Swagger UI (/docs).
app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    description="Advanced API for MindPal: An AI Mental Wellness Companion.",
    docs_url="/docs",
    redoc_url="/redoc"
)

# --- MIDDLEWARE ---

# CORS (Cross-Origin Resource Sharing) setup.
# In a true production environment, `allow_origins` should be restricted 
# to the specific domain where the frontend is hosted (e.g., ["https://mindpal.com"]).
# For local development, "*" allows the frontend to communicate with the backend seamlessly.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # TODO: Restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global Exception Handler (Optional but Recommended)
# This catches unhandled server errors and returns a clean JSON response 
# instead of crashing the server or leaking raw traceback data to the client.
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    # In a production app, you would log the `exc` to a monitoring service (like Sentry) here.
    print(f"Unhandled Exception: {exc}") 
    return JSONResponse(
        status_code=500,
        content={"status": "error", "message": "An internal server error occurred.", "details": str(exc)},
    )

# --- ROUTERS ---

# We will include our feature-specific routers here once they are built.
# This modularizes the codebase, keeping main.py clean.
# Example:
# from api.chat_router import router as chat_router
# from api.user_router import router as user_router
# from api.memory_router import router as memory_router

# app.include_router(chat_router, prefix="/api", tags=["Chat"])
# app.include_router(user_router, prefix="/api", tags=["User"])
# app.include_router(memory_router, prefix="/api", tags=["Memory"])


# --- ENDPOINTS ---

@app.get("/health", tags=["System"])
async def health_check():
    """
    A simple health check endpoint used by deployment platforms (Render, AWS, etc.)
    to verify the server is alive and responding.
    """
    return {
        "status": "ok",
        "service": settings.PROJECT_NAME,
        "version": settings.VERSION
    }

# --- ENTRY POINT ---

if __name__ == "__main__":
    # Runs the server locally when executing `python main.py`.
    # Using `reload=True` enables auto-reloading during development.
    uvicorn.run(
        "main:app", 
        host="0.0.0.0", 
        port=8000, 
        reload=True,
        log_level="info"
    )