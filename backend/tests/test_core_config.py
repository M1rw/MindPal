import os
from backend.core.config import Settings

def test_config_defaults():
    # Make sure we don't load accidental environment variables for this test
    os.environ.pop("ENABLE_FIREBASE", None)
    os.environ.pop("CORS_ORIGINS", None)
    
    settings = Settings()
    assert settings.PROJECT_NAME == "MindPal"
    assert settings.is_development is True
    assert settings.firebase_enabled is False
    assert settings.has_gemini is False

def test_cors_parsing():
    os.environ["CORS_ORIGINS"] = "http://a.com, http://b.com "
    settings = Settings()
    assert settings.CORS_ORIGINS == ["http://a.com", "http://b.com"]
    os.environ.pop("CORS_ORIGINS")

def test_helper_properties():
    os.environ["ENABLE_FIREBASE"] = "true"
    os.environ["FIREBASE_CREDENTIALS_PATH"] = "/tmp/fake.json"
    settings = Settings()
    assert settings.firebase_enabled is True
    
    os.environ.pop("ENABLE_FIREBASE")
    os.environ.pop("FIREBASE_CREDENTIALS_PATH")
