"""Deterministic arithmetic tool for verified numeric answers."""

from __future__ import annotations

import ast
import math
from decimal import Decimal, InvalidOperation
from typing import Any

from backend.core.security import sanitize_text
from backend.tools import BaseTool, ToolContext, ToolResult

MAX_EXPRESSION_CHARS = 160
MAX_ABS_VALUE = Decimal("1000000000000")
MAX_EXPONENT = 12


class CalculationTool(BaseTool):
    """Evaluate a small, side-effect-free arithmetic expression."""

    @property
    def name(self) -> str:
        return "calculate_expression"

    @property
    def description(self) -> str:
        return (
            "Calculate a numeric arithmetic expression exactly. Use for arithmetic, "
            "percentages, ratios, or unit-free numeric transforms; never do the math mentally."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "OBJECT",
            "properties": {
                "expression": {
                    "type": "STRING",
                    "description": "Arithmetic using numbers, parentheses, +, -, *, /, //, %, and ** only",
                },
            },
            "required": ["expression"],
        }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        expression = sanitize_text(str(args.get("expression", "")), MAX_EXPRESSION_CHARS).strip()
        if not expression:
            return ToolResult(error="An arithmetic expression is required.")
        try:
            tree = ast.parse(expression, mode="eval")
            result = _evaluate_node(tree.body)
        except (SyntaxError, ValueError, ZeroDivisionError, InvalidOperation) as exc:
            return ToolResult(error=f"Could not safely calculate that expression: {type(exc).__name__}.")

        if not result.is_finite() or abs(result) > MAX_ABS_VALUE:
            return ToolResult(error="The calculation result is outside MindPal's safe numeric range.")

        rendered = _render_decimal(result)
        return ToolResult(data={"expression": expression, "result": rendered, "numeric_result": float(result)})


def _decimal_from_constant(value: object) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("Only numeric constants are allowed")
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("Non-finite values are not allowed")
    number = Decimal(str(value))
    if abs(number) > MAX_ABS_VALUE:
        raise ValueError("Numeric constant is too large")
    return number


def _evaluate_node(node: ast.AST) -> Decimal:
    if isinstance(node, ast.Constant):
        return _decimal_from_constant(node.value)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        value = _evaluate_node(node.operand)
        return value if isinstance(node.op, ast.UAdd) else -value
    if not isinstance(node, ast.BinOp):
        raise ValueError("Only arithmetic operators are allowed")

    left = _evaluate_node(node.left)
    right = _evaluate_node(node.right)
    if isinstance(node.op, ast.Add):
        return left + right
    if isinstance(node.op, ast.Sub):
        return left - right
    if isinstance(node.op, ast.Mult):
        return left * right
    if isinstance(node.op, ast.Div):
        return left / right
    if isinstance(node.op, ast.FloorDiv):
        return left // right
    if isinstance(node.op, ast.Mod):
        return left % right
    if isinstance(node.op, ast.Pow):
        if right != right.to_integral_value() or abs(right) > MAX_EXPONENT:
            raise ValueError("Exponent must be a small whole number")
        return left ** int(right)
    raise ValueError("Unsupported arithmetic operator")


def _render_decimal(value: Decimal) -> str:
    normalized = value.normalize()
    text = format(normalized, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text
