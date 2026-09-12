# MindPal RAG Corpus

MindPal uses a small curated YAML corpus for lightweight retrieval-augmented grounding.

This corpus is intentionally not a medical, diagnostic, or therapy knowledge base. It exists to help the assistant choose safer, clearer, and more practical response patterns for common user states such as anxiety, overwhelm, conflict, rumination, study stress, and safety concerns.

## Current corpus files

```txt
backend/rag/corpus/
├── anxiety_grounding.yaml
├── cbt_grounding.yaml
├── dbt_grounding.yaml
├── emotion_regulation.yaml
├── cognitive_support.yaml
├── relationship_support.yaml
└── safety_support.yaml