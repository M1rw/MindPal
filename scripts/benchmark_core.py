from __future__ import annotations

import time
from backend.services.domain.llm.message_classifier import classify_message
from backend.services.domain.llm.freshness import requires_verified_web_search


def benchmark_message_classifier(iterations: int = 10_000):
    messages = [
        "Hello, how are you today?",
        "I feel really overwhelmed and stressed out about my exams.",
        "What is the current price of Bitcoin right now?",
        "إنت عامل ايه؟ أنا تعبان ومضايق أوي",
    ]
    start = time.perf_counter()
    for _ in range(iterations):
        for msg in messages:
            classify_message(msg)
    elapsed = time.perf_counter() - start
    total_calls = iterations * len(messages)
    calls_per_sec = total_calls / elapsed
    print(f"Message Classifier: {total_calls:,} calls in {elapsed:.4f}s ({calls_per_sec:,.0f} ops/sec)")


def benchmark_freshness(iterations: int = 10_000):
    messages = [
        "Who is the current prime minister of the UK?",
        "Tell me a story about a dragon.",
        "من هو رئيس مجلس الوزراء الحالي؟",
    ]
    start = time.perf_counter()
    for _ in range(iterations):
        for msg in messages:
            requires_verified_web_search(msg)
    elapsed = time.perf_counter() - start
    total_calls = iterations * len(messages)
    calls_per_sec = total_calls / elapsed
    print(f"Freshness Check: {total_calls:,} calls in {elapsed:.4f}s ({calls_per_sec:,.0f} ops/sec)")


if __name__ == "__main__":
    print("=== MindPal Core Performance Benchmark ===")
    benchmark_message_classifier()
    benchmark_freshness()
