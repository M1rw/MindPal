from backend.models.runtime_trace import RuntimeNode
from backend.services.runtime_trace_service import RuntimeTraceRecorder


def test_runtime_trace_orders_real_nodes_and_redacts_content_metadata() -> None:
    recorder = RuntimeTraceRecorder("request-safe-mode")
    recorder.started(metadata={"channel": "web", "message": "must not be retained"})
    recorder.node_started(RuntimeNode.RETRIEVAL, parent=RuntimeNode.CONTEXT)
    recorder.node_completed(
        RuntimeNode.RETRIEVAL,
        parent=RuntimeNode.CONTEXT,
        metadata={"reference_count": 4, "content": "must not be retained"},
    )
    recorder.node_started(RuntimeNode.MODEL, parent=RuntimeNode.RETRIEVAL)
    recorder.node_completed(RuntimeNode.MODEL, parent=RuntimeNode.RETRIEVAL, metadata={"provider": "test", "latency_ms": 9})
    recorder.complete(metadata={"memory_updated": False})

    trace = recorder.trace()

    assert trace.completed is True
    assert [event.sequence for event in trace.events] == list(range(1, len(trace.events) + 1))
    assert trace.events[1].node is RuntimeNode.RETRIEVAL
    assert trace.events[2].metadata == {"reference_count": 4}
    assert trace.events[-1].node is RuntimeNode.OUTPUT
    assert "message" not in trace.events[0].metadata


def test_runtime_trace_marks_failed_node_without_payload() -> None:
    recorder = RuntimeTraceRecorder("request-failure")
    recorder.started()
    recorder.node_started(RuntimeNode.WEB, parent=RuntimeNode.TOOL_ROUTER)
    recorder.failed(RuntimeNode.WEB, code="tool_failed")

    event = recorder.trace().events[-1]

    assert event.node is RuntimeNode.WEB
    assert event.status == "failed"
    assert event.metadata == {"code": "tool_failed"}
