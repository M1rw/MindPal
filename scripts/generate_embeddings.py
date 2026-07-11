import asyncio
import json
import yaml
from pathlib import Path
from backend.api.dependencies import get_service_container

async def main():
    services = get_service_container()
    if not services.llm:
        print("Error: LLM service is not configured.")
        return
        
    print(f"Using provider: {services.llm.providers[0].name}")
        
    corpus_dir = Path("backend/rag/corpus")
    output_file = Path("backend/rag/corpus_embeddings.json")
    
    if not corpus_dir.exists():
        print(f"Error: Corpus directory not found at {corpus_dir}")
        return
        
    all_units = []
    
    # Load all YAMLs
    for file_path in corpus_dir.glob("*.yaml"):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f)
                
            for item in data.get("units", []):
                all_units.append(item)
                
        except Exception as e:
            print(f"Error reading {file_path}: {e}")
            
    print(f"Found {len(all_units)} grounding units. Generating embeddings...")
    
    # Prepare texts to embed (combining trigger_terms and instructions to capture semantic meaning)
    texts_to_embed = []
    for item in all_units:
        terms = item.get("trigger_terms", [])
        instructions = item.get("instructions", [])
        
        # Ensure all items are strings
        safe_terms = [str(t) for t in terms]
        safe_instructions = [str(i) for i in instructions]
        
        combined = " ".join(safe_terms) + " " + " ".join(safe_instructions)
        texts_to_embed.append(combined)
        
    # Chunk into sizes of 50 to avoid API limits (if any)
    batch_size = 50
    all_vectors = []
    
    for i in range(0, len(texts_to_embed), batch_size):
        batch = texts_to_embed[i:i + batch_size]
        try:
            print(f"Embedding batch {i//batch_size + 1}/{(len(texts_to_embed) + batch_size - 1)//batch_size}...")
            # We assume services.llm.embed exists
            vectors = await services.llm.embed(batch)
            all_vectors.extend(vectors)
        except Exception as e:
            import traceback
            traceback.print_exc()
            print(f"Error details: {getattr(e, 'details', 'No details')}")
            print(f"Error generating embeddings for batch {i//batch_size + 1}: {e}")
            return
            
    if len(all_vectors) != len(all_units):
        print(f"Error: Generated {len(all_vectors)} vectors for {len(all_units)} units.")
        return
        
    # Combine into a final cache structure
    output_data = {}
    for i, unit in enumerate(all_units):
        uid = unit.get("id") or unit.get("grounding_id") or f"unit_{i}"
        output_data[uid] = {
            "unit": unit,
            "vector": all_vectors[i]
        }
        
    # Write to JSON
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(output_data, f, ensure_ascii=False)
        
    print(f"Successfully saved {len(output_data)} embedded units to {output_file}")

if __name__ == "__main__":
    asyncio.run(main())
