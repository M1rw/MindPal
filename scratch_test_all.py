import asyncio
import os
from dotenv import load_dotenv

from backend.core.config import get_settings, reset_settings
from backend.providers import build_llm_providers, build_tts_providers

async def test_individual_provider(provider, settings):
    """Test a single LLM provider directly."""
    print(f"\n--- Testing {provider.name} ---")
    print(f"  Configured: {provider.is_configured}")
    
    if not provider.is_configured:
        print("  SKIPPED (not configured)")
        return False

    from backend.models.chat import LLMMessage, LLMRole, LLMRequest
    request = LLMRequest(
        request_id=f"test-{provider.name}",
        messages=[
            LLMMessage(role=LLMRole.SYSTEM, content="You are a helpful assistant."),
            LLMMessage(role=LLMRole.USER, content="Say exactly 'hello world'. No other text."),
        ],
        temperature=0.01,
        max_output_tokens=64,
    )

    try:
        response = await asyncio.wait_for(provider.generate(request), timeout=30)
        print(f"  SUCCESS: {response.text[:100]}")
        return True
    except Exception as e:
        print(f"  FAILED: {type(e).__name__}: {str(e)[:200]}")
        return False


async def test_tts_provider(provider):
    """Test a single TTS provider."""
    print(f"\n--- Testing TTS: {provider.name} ---")
    print(f"  Configured: {provider.is_configured}")
    
    if not provider.is_configured:
        print("  SKIPPED (not configured)")
        return False

    try:
        # Just check health, don't actually synthesize
        health = await provider.health()
        print(f"  Health: {health}")
        return True
    except Exception as e:
        print(f"  FAILED: {type(e).__name__}: {str(e)[:200]}")
        return False


async def test_firebase_json():
    """Test Firebase credentials JSON parsing."""
    from backend.providers.firebase_provider import FirebaseProviderConfig, _parse_credentials_json
    
    settings = get_settings()
    config = FirebaseProviderConfig.from_settings(settings)
    
    print("\n--- Testing Firebase Config ---")
    print(f"  project_id: {config.project_id}")
    print(f"  credentials_json present: {bool(config.credentials_json)}")
    print(f"  credentials_path present: {bool(config.credentials_path)}")
    print(f"  app_name: {config.app_name}")
    print(f"  firestore_database_id: {config.firestore_database_id}")
    
    if config.credentials_json:
        try:
            data = _parse_credentials_json(config.credentials_json, expected_project_id=config.project_id)
            print(f"  JSON parse: SUCCESS (project_id={data.get('project_id')})")
            print(f"  client_email: {data.get('client_email', 'MISSING')}")
            print(f"  private_key present: {bool(data.get('private_key'))}")
            pk = data.get('private_key', '')
            print(f"  private_key starts with BEGIN: {pk.startswith('-----BEGIN')}")
            print(f"  private_key ends with END: {'-----END' in pk}")
            return True
        except Exception as e:
            print(f"  JSON parse FAILED: {e}")
            return False
    else:
        print("  No JSON credentials found")
        return False


async def main():
    load_dotenv('.env.local', override=True)
    os.environ['ENVIRONMENT'] = 'development'
    reset_settings()
    settings = get_settings()

    results = {}
    
    # 1. Test each LLM provider individually
    print("=" * 60)
    print("LLM PROVIDER TESTS")
    print("=" * 60)
    
    providers = build_llm_providers(settings, include_unconfigured=True)
    for provider in providers:
        ok = await test_individual_provider(provider, settings)
        results[f"llm:{provider.name}"] = ok

    # 2. Test TTS providers
    print("\n" + "=" * 60)
    print("TTS PROVIDER TESTS")
    print("=" * 60)
    
    tts_providers = build_tts_providers(settings, include_unconfigured=True)
    for provider in tts_providers:
        ok = await test_tts_provider(provider)
        results[f"tts:{provider.name}"] = ok

    # 3. Test Firebase credentials
    print("\n" + "=" * 60)
    print("FIREBASE CONFIG TEST")
    print("=" * 60)
    
    ok = await test_firebase_json()
    results["firebase:credentials"] = ok

    # 4. Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    for name, passed in results.items():
        status = "PASS" if passed else "FAIL"
        print(f"  [{status}] {name}")
    
    total = len(results)
    passed = sum(1 for v in results.values() if v)
    print(f"\n  {passed}/{total} tests passed")


if __name__ == "__main__":
    asyncio.run(main())
