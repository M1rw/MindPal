from __future__ import annotations

import pytest
from backend.core.errors import AppError, MindPalError, SecurityError, ValidationAppError


def test_error_hierarchy():
    err = SecurityError("Access denied", details={"ip": "127.0.0.1"})
    assert isinstance(err, AppError)
    assert isinstance(err, MindPalError)
    assert err.status_code == 400
    assert err.code == "security_error"
    assert err.details == {"ip": "127.0.0.1"}


def test_validation_app_error():
    err = ValidationAppError("Field required")
    assert err.status_code == 422
    assert err.code == "validation_error"
