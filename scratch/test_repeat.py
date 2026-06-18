import asyncio
import httpx
import json

async def main():
    async with httpx.AsyncClient() as client:
        payload = {
            "message": "أنا حاسس اني مخنوق جدا وتعبان",
            "history": [],
            "metadata": {"model": "pro"}
        }
        try:
            async with client.stream("POST", "http://localhost:8000/api/chat/stream", json=payload, headers={"x-test-user-id": "test-user"}, timeout=60.0) as response:
                print(f"Status: {response.status_code}")
                full_text = ""
                async for line in response.aiter_lines():
                    if line.startswith("data: "):
                        data_str = line[6:]
                        if data_str == "[DONE]": break
                        try:
                            data = json.loads(data_str)
                            if "text" in data:
                                full_text += data["text"]
                                print(data["text"], end="", flush=True)
                        except Exception as e:
                            pass
                print("\n\n--- Full Text ---")
                print(full_text)
        except Exception as e:
            print("Error connecting:", e)

if __name__ == "__main__":
    asyncio.run(main())
