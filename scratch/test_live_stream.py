"""
Test the actual live streaming endpoint to see what the backend returns.
This hits the real API to check if spaces are present in the SSE output.
"""
import json
import httpx
import asyncio

async def test_live_stream():
    url = "https://mindpal-demo.vercel.app/api/chat/stream"
    payload = {
        "message": "I feel sad today",
        "history": [],
        "metadata": {
            "locale": "en",
            "mode": "active_listen",
            "model": "standard"
        },
        "stream": True
    }
    
    print("Sending test message to live API...")
    print(f"URL: {url}")
    print(f"Message: {payload['message']}")
    print()
    
    full_text = ""
    chunk_count = 0
    chunks_with_leading_space = 0
    chunks_without_leading_space = 0
    
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            async with client.stream("POST", url, json=payload, headers={"Content-Type": "application/json"}) as response:
                print(f"Response status: {response.status_code}")
                
                if response.status_code >= 400:
                    body = await response.aread()
                    print(f"Error: {body.decode()}")
                    return
                
                async for line in response.aiter_lines():
                    if line.startswith("data: "):
                        data_str = line[6:].strip()
                        if data_str == "[DONE]":
                            break
                        try:
                            data = json.loads(data_str)
                            if "text" in data:
                                text = data["text"]
                                chunk_count += 1
                                full_text += text
                                
                                # Track leading spaces
                                if text and text[0] == " ":
                                    chunks_with_leading_space += 1
                                else:
                                    chunks_without_leading_space += 1
                                
                                # Print first 30 chunks for debugging
                                if chunk_count <= 30:
                                    print(f"  Chunk {chunk_count:3d}: {repr(text)}")
                            
                            elif data.get("type") == "status":
                                print(f"  [STATUS] {data.get('status')}")
                            elif data.get("type") == "metadata":
                                print(f"  [META] provider={data.get('provider_used', '?')}")
                                
                        except json.JSONDecodeError:
                            pass
                    
    except Exception as e:
        print(f"Error: {e}")
        return
    
    print()
    print("=" * 70)
    print("RESULTS")
    print("=" * 70)
    print(f"Total chunks: {chunk_count}")
    print(f"Chunks WITH leading space: {chunks_with_leading_space}")
    print(f"Chunks WITHOUT leading space: {chunks_without_leading_space}")
    print(f"Full text has spaces: {'YES' if ' ' in full_text else 'NO -- BUG!'}")
    print()
    print(f"Full text ({len(full_text)} chars):")
    print(full_text[:500])
    
    if " " not in full_text:
        print()
        print("!!! BUG: No spaces in output. The streaming extractor fix is NOT active in production!")
        print("!!! Check Vercel deployment logs for errors.")

asyncio.run(test_live_stream())
