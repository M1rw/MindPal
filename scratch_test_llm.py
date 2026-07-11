import asyncio
import os
from dotenv import load_dotenv

from backend.core.config import get_settings, reset_settings
from backend.providers import build_llm_providers
from backend.services.llm_service import LLMService, build_llm_request

async def main():
    load_dotenv('.env.local', override=True)
    os.environ['ENVIRONMENT'] = 'development'
    reset_settings()
    settings = get_settings()

    print("Testing LLM Service...")
    providers = build_llm_providers(settings)
    
    for provider in providers:
        print(f"Provider {provider.name}: Configured={provider.is_configured}")

    llm = LLMService(providers=providers, settings=settings)

    request = build_llm_request(
        request_id="test-123",
        system_prompt="You are a helpful assistant.",
        user_message="Say exactly 'hello world'. No other text.",
        temperature=0.01,
        max_output_tokens=100
    )

    print("\nAttempting completion...")
    try:
        result = await llm.generate_with_trace(request)
        print(f"Success! Provider used: {result.response.provider_used}")
        print(f"Response: {result.response.text}")
        print("\nTrace:")
        for call in result.trace.calls:
            print(f"  - {call.provider}: attempted={call.attempted}, succeeded={call.succeeded}, skipped={call.skipped}, error={call.error_code}")
    except Exception as e:
        print(f"Failed: {e}")

if __name__ == "__main__":
    asyncio.run(main())
