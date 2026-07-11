import os
import asyncio
from dotenv import load_dotenv
from backend.core.config import get_settings, reset_settings
from backend.providers.firebase_provider import FirebaseProvider, FirebaseProviderConfig

async def main():
    load_dotenv('.env.local', override=True)
    os.environ['ENVIRONMENT'] = 'development'
    reset_settings()
    settings = get_settings()
    
    print("Testing Firebase Configuration...")
    print(f"Has JSON string configured: {settings.FIREBASE_CREDENTIALS_JSON is not None}")
    
    config = FirebaseProviderConfig.from_settings(settings)
    provider = FirebaseProvider(config)
    
    print(f"Is Configured: {provider.is_configured}")
    
    from backend.providers.firebase_provider import _parse_credentials_json
    
    if config.credentials_json:
        try:
            data = _parse_credentials_json(config.credentials_json, expected_project_id=config.project_id)
            print("Successfully parsed FIREBASE_CREDENTIALS_JSON!")
            print(f"Parsed project_id: {data.get('project_id')}")
        except Exception as e:
            print(f"Failed to parse: {e}")
    else:
        print("No JSON string found")

if __name__ == "__main__":
    asyncio.run(main())
