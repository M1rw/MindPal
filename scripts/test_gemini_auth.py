import asyncio
from backend.api.dependencies import get_service_container
from backend.services.llm_service import build_llm_request

async def main():
    services = get_service_container()
    
    from backend.core.config import get_settings
    s = get_settings()
    print("CF Token:", getattr(s, "CLOUDFLARE_AIG_TOKEN", None))
    print("CF Account:", getattr(s, "CLOUDFLARE_ACCOUNT_ID", None))
    
    print("Providers:")
    for p in services.llm.providers:
        print(f"- {p.name} (configured={p.is_configured})")
        
    req = build_llm_request(
        request_id="test",
        system_prompt="You are helpful.",
        user_message="Say hello",
    )
    res = await services.llm.generate(req)
    print("Response class:", type(res))
    if hasattr(res, "text"):
        print("Response text:", res.text)
    elif hasattr(res, "response"):
        print("Response text:", res.response.text)

if __name__ == "__main__":
    asyncio.run(main())
