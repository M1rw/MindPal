import asyncio
from backend.api.dependencies import get_service_container
from backend.services.memory_graph_service import extract_memory_graph_from_text_llm
from backend.core.config import get_settings

async def main():
    services = get_service_container()
    llm = services.llm
    text = "Please try to be less enthusiastic. It makes me anxious when you use too many exclamation marks."
    print("User said:", text)
    graph = await extract_memory_graph_from_text_llm(
        text,
        user_id_hash="test1234",
        llm_service=llm,
    )
    for atom in graph.atoms:
        print(f"[{atom.category.value}] {atom.display_value} (conf={atom.confidence})")

if __name__ == "__main__":
    asyncio.run(main())
