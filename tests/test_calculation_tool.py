from __future__ import annotations

import asyncio
from types import SimpleNamespace

from backend.tools import ToolContext, build_default_registry
from backend.tools.calculation_tool import CalculationTool


def _context() -> ToolContext:
    return ToolContext(
        user_id_hash="test-user",
        authenticated=True,
        locale="en",
        timezone="Africa/Cairo",
        request_id="calculation-test",
        services=SimpleNamespace(),
    )


def test_calculation_tool_returns_verified_decimal_result() -> None:
    result = asyncio.run(CalculationTool().execute({"expression": "19.5 * 1.14"}, _context()))

    assert result.ok
    assert result.data["result"] == "22.23"
    assert result.data["numeric_result"] == 22.23


def test_calculation_tool_rejects_code_and_unbounded_exponents() -> None:
    unsafe = asyncio.run(CalculationTool().execute({"expression": "__import__('os').system('id')"}, _context()))
    exponent = asyncio.run(CalculationTool().execute({"expression": "2 ** 99"}, _context()))

    assert not unsafe.ok
    assert not exponent.ok


def test_calculation_tool_is_available_to_shared_registry() -> None:
    assert "calculate_expression" in build_default_registry().tool_names
