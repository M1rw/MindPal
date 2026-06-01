from backend.core.errors import MindPalError, ValidationError, ProviderTimeoutError

def test_mindpal_error_dict():
    err = MindPalError("Test fail", details={"k": "v"})
    d = err.to_dict()
    assert d["error"] == "internal_error"
    assert d["message"] == "Test fail"
    assert d["details"]["k"] == "v"

def test_validation_error():
    err = ValidationError("Bad input")
    assert err.code == "validation_error"
    assert err.status_code == 400

def test_provider_timeout_error():
    err = ProviderTimeoutError()
    assert err.code == "provider_timeout"
    assert err.status_code == 504
