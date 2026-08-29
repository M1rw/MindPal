# backend/features/tools/calculation.py

"""
Calculation tool for safe arithmetic evaluations.
"""

from __future__ import annotations

import ast
import operator
from decimal import Decimal, InvalidOperation
from typing import Any

from backend.core.security import sanitize_text
from .base import BaseTool, ToolContext, ToolResult

MAX_EXPRESSION_CHARS = 160
MAX_ABS_VALUE = Decimal("1000000000000")
MAX_EXPONENT = 12

_SAFE_OPERATORS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
    ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}


class CalculationTool(BaseTool):
    """Safely evaluates basic arithmetic expressions without arbitrary code execution."""

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
                    "description": "Mathematical expression to evaluate (e.g. '24 * 7', '1500 / 12')",
                }
            },
            "required": ["expression"],
        }

    async def execute(self, args: dict[str, Any], context: ToolContext) -> ToolResult:
        raw_expr = sanitize_text(str(args.get("expression") or ""), MAX_EXPRESSION_CHARS).strip()
        if not raw_expr:
            return ToolResult(error="An arithmetic expression is required.")

        try:
            tree = ast.parse(raw_expr, mode="eval")
            result = _eval_ast(tree.body)
            if isinstance(result, float) and result.is_integer():
                result = int(result)
            return ToolResult(data={"expression": raw_expr, "result": str(result), "numeric_result": float(result)})
        except (ValueError, TypeError, ZeroDivisionError, OverflowError) as exc:
            return ToolResult(error=f"Could not safely calculate that expression: {type(exc).__name__}.")
        except Exception:
            return ToolResult(error="Could not safely calculate that expression: SyntaxError.")


def _eval_ast(node: ast.AST) -> int | float:
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.UnaryOp) and type(node.op) in _SAFE_OPERATORS:
        operand = _eval_ast(node.operand)
        return _SAFE_OPERATORS[type(node.op)](operand)
    if isinstance(node, ast.BinOp) and type(node.op) in _SAFE_OPERATORS:
        left = _eval_ast(node.left)
        right = _eval_ast(node.right)
        if isinstance(node.op, ast.Pow) and (right > MAX_EXPONENT or left > 10_000):
            raise OverflowError("Exponent too large")
        return _SAFE_OPERATORS[type(node.op)](left, right)
    raise ValueError(f"Unsupported AST node: {type(node).__name__}")
