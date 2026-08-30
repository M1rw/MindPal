from backend.services.core.metrics import get_metrics_registry, record_provider_request, record_service_request, render_metrics


def test_metrics_registry_tracks_prometheus_output():
    registry = get_metrics_registry()
    record_service_request("llm_service", "generate", 123.0, status="success")
    record_provider_request("gemini", "generate", 98.5, status="success")

    output = render_metrics()
    assert "mindpal_service_requests_total" in output
    assert "mindpal_provider_requests_total" in output
    assert "mindpal_service_request_duration_ms_count" in output
