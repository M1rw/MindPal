import os

file_path = "backend/services/memory_graph_service.py"

with open(file_path, "r", encoding="utf-8") as f:
    content = f.read()

imports = """
from backend.services.llm_service import LLMService, build_llm_request
import json
"""

# Add imports right after 'from typing import Any'
if "from backend.services.llm_service import LLMService" not in content:
    content = content.replace("from typing import Any", "from typing import Any\n" + imports)

llm_code = '''

MEMORY_GRAPH_SYSTEM_PROMPT = """
You are MindPal's realtime memory extraction engine.

Your job is to read a chat message from the user and extract any durable personal facts, relationships, preferences, or goals.
If no memory is found, return an empty array.

Return EXACTLY a JSON object with this shape:
{
  "atoms": [
    {
      "category": "profile|people|projects|preferences|avoid|patterns|goals|relationship_context|coping_tools|safety_context|facts",
      "value": "string max 180 chars",
      "confidence": 0.0 to 1.0,
      "sensitivity": "low|medium|high",
      "aliases": ["optional list of strings"],
      "metadata": {}
    }
  ]
}

DO NOT wrap the JSON in Markdown formatting like ```json.
"""

async def extract_memory_graph_from_text_llm(
    text: str,
    *,
    user_id_hash: str,
    llm_service: LLMService,
    explicit: bool | None = None,
) -> MemoryGraph:
    cleaned = sanitize_text(str(text or ""), 2_000)
    if not cleaned:
        return MemoryGraph(user_id_hash=user_id_hash, atoms=[], full_snapshot=False)
        
    explicit = _is_explicit_memory_command(cleaned) if explicit is None else explicit
    source = MemorySource.MANUAL if explicit else MemorySource.CHAT_EXTRACTION
    confidence_cap = MANUAL_CONFIDENCE if explicit else CHAT_CONFIDENCE

    req = build_llm_request(
        request_id="mem_extract",
        system_prompt=MEMORY_GRAPH_SYSTEM_PROMPT.strip(),
        user_message=cleaned,
        temperature=0.1,
        max_output_tokens=800,
        metadata={"purpose": "realtime_memory_extraction"}
    )
    
    atoms_out = []
    
    try:
        res = await llm_service.generate_with_trace(req)
        raw_text = res.response.text.strip()
        
        if raw_text.startswith("```json"):
            raw_text = raw_text.split("```json")[1].split("```")[0].strip()
        elif raw_text.startswith("```"):
            raw_text = raw_text.split("```")[1].split("```")[0].strip()
            
        data = json.loads(raw_text)
        
        for atom_data in data.get("atoms", []):
            try:
                atoms_out.append(make_memory_atom(
                    user_id_hash=user_id_hash,
                    category=MemoryCategory(atom_data.get("category", "facts")),
                    value=atom_data.get("value", ""),
                    confidence=min(confidence_cap, float(atom_data.get("confidence", 0.6))),
                    source=source,
                    sensitivity=MemorySensitivity(atom_data.get("sensitivity", "medium")),
                    aliases=atom_data.get("aliases", []),
                    metadata=atom_data.get("metadata", {}),
                    pinned=explicit,
                ))
            except Exception:
                pass # skip invalid atoms
                
    except Exception as e:
        print(f"LLM memory extraction failed: {e}")
        pass

    return MemoryGraph(
        user_id_hash=user_id_hash,
        atoms=atoms_out,
        source=source,
        full_snapshot=False,
    )
'''

if "extract_memory_graph_from_text_llm" not in content:
    content += llm_code

with open(file_path, "w", encoding="utf-8") as f:
    f.write(content)
