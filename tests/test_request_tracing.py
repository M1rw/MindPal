from backend.services.core.request_tracing import RequestTracer


def test_request_tracer_tracks_request_metadata():
    trace = RequestTracer.start_request(
        request_id="req-123",
        user_id_hash="user-hash",
        channel="web",
        operation="chat.generate",
    )

    RequestTracer.record_provider_call(
        "gemini",
        model_name="gemini-2.0-flash",
        operation="generate",
        status="success",
        prompt_tokens=5,
        completion_tokens=7,
        error_code=None,
        provider_cost_cents=12,
    )

    finished = RequestTracer.end_request(success=True)

    assert finished is not None
    assert finished.request_id == "req-123"
    assert finished.status == "success"
    assert finished.provider_calls
    assert finished.total_tokens_used == 12
    assert RequestTracer.get_current_request_id() == ""
