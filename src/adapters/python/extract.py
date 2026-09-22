"""
pytest adapter for TestSlop.

Reads {"path": ..., "content": ..., "kind": "test"|"production"} as JSON on
stdin and writes the normalised TestSlop model as JSON on stdout.

This exists to answer one architectural question honestly: is the normalised
model in src/core/types.ts actually language-neutral, or is it Jest's data model
wearing a costume? Everything here maps pytest concepts onto the same
StrengthClass lattice used for Jest, and the rule engine consumes the output
without a single pytest-specific branch.

Uses only the standard library `ast` module. No third-party dependency, and no
need for the project under analysis to have pytest installed.
"""

from __future__ import annotations

import ast
import json
import sys

# --- Assertion strength -----------------------------------------------------
# Mirrors src/adapters/ts/strength.ts. The lattice is the shared contract.

INTERACTION_METHODS = {
    "assert_called",
    "assert_called_once",
    "assert_called_with",
    "assert_called_once_with",
    "assert_any_call",
    "assert_has_calls",
    "assert_not_called",
}

CMP_STRENGTH = {
    ast.Eq: ("EXACT", "value"),
    ast.NotEq: ("VACUOUS", "value"),
    ast.Is: ("EXACT", "value"),
    ast.IsNot: ("EXISTENCE", "value"),
    ast.Lt: ("CONSTRAINED", "value"),
    ast.LtE: ("CONSTRAINED", "value"),
    ast.Gt: ("CONSTRAINED", "value"),
    ast.GtE: ("CONSTRAINED", "value"),
    ast.In: ("STRUCTURAL", "value"),
    ast.NotIn: ("VACUOUS", "value"),
}


def src(node, lines):
    try:
        seg = ast.get_source_segment("\n".join(lines), node)
        if seg:
            return " ".join(seg.split())
    except Exception:
        pass
    return ""


def literal_kind(node):
    if isinstance(node, ast.Constant):
        v = node.value
        if isinstance(v, bool):
            return "boolean"
        if isinstance(v, (int, float)):
            return "number"
        if isinstance(v, str):
            return "string"
        if v is None:
            return "null"
    if isinstance(node, ast.Dict):
        return "object"
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return "array"
    if isinstance(node, ast.Call):
        return "call"
    if isinstance(node, (ast.Name, ast.Attribute)):
        return "identifier"
    if isinstance(node, ast.UnaryOp) and isinstance(node.operand, ast.Constant):
        return literal_kind(node.operand)
    return "expression"


def make_arg(node, lines):
    raw = src(node, lines)
    kind = literal_kind(node)
    arg = {"raw": raw, "kind": kind}
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        arg["numeric"] = node.value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub) and isinstance(node.operand, ast.Constant):
        if isinstance(node.operand.value, (int, float)):
            arg["numeric"] = -node.operand.value
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        arg["string"] = node.value
    return arg


def identifiers_in(node):
    out = []
    for n in ast.walk(node):
        if isinstance(n, ast.Name):
            out.append(n.id)
        elif isinstance(n, ast.Attribute):
            out.append(n.attr)
    seen, uniq = set(), []
    for x in out:
        if x not in seen:
            seen.add(x)
            uniq.append(x)
    return uniq


def is_approx(node):
    """pytest.approx(...) relaxes an equality into a tolerance check."""
    for n in ast.walk(node):
        if isinstance(n, ast.Call):
            f = n.func
            if isinstance(f, ast.Attribute) and f.attr == "approx":
                return True
            if isinstance(f, ast.Name) and f.id == "approx":
                return True
    return False


def classify_assert(node, lines):
    """Maps a bare `assert` statement onto the shared strength lattice."""
    test = node.test

    # assert isinstance(x, T)
    if isinstance(test, ast.Call) and isinstance(test.func, ast.Name) and test.func.id == "isinstance":
        subject = test.args[0] if test.args else test
        return {
            "matcher": "isinstance",
            "negated": False,
            "strength": "TYPE_ONLY",
            "aspect": "value",
            "subject": src(subject, lines),
            "args": [make_arg(a, lines) for a in test.args[1:]],
            "subjectIdentifiers": identifiers_in(subject),
        }

    # assert x.assert_called_once_with(...) is unusual; mock asserts are
    # expression statements, handled by the caller.

    # assert not x
    if isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not):
        return {
            "matcher": "truthy",
            "negated": True,
            "strength": "EXISTENCE",
            "aspect": "value",
            "subject": src(test.operand, lines),
            "args": [],
            "subjectIdentifiers": identifiers_in(test.operand),
        }

    if isinstance(test, ast.Compare) and test.ops:
        op = type(test.ops[0])
        strength, aspect = CMP_STRENGTH.get(op, ("STRUCTURAL", "value"))
        comparator = test.comparators[0] if test.comparators else test
        # `is None` pins one value; `is not None` only rules out absence.
        if op is ast.Is and isinstance(comparator, ast.Constant) and comparator.value is None:
            strength = "EXACT"
        if op is ast.IsNot and isinstance(comparator, ast.Constant) and comparator.value is None:
            strength = "EXISTENCE"
        if op is ast.Eq and is_approx(comparator):
            strength = "CONSTRAINED"
        if op is ast.Eq and literal_kind(comparator) in ("identifier", "call", "expression"):
            strength = "EXACT"
        matcher_name = {
            ast.Eq: "eq", ast.NotEq: "ne", ast.Is: "is", ast.IsNot: "is_not",
            ast.Lt: "lt", ast.LtE: "le", ast.Gt: "gt", ast.GtE: "ge",
            ast.In: "in", ast.NotIn: "not_in",
        }.get(op, "cmp")
        return {
            "matcher": matcher_name,
            "negated": op in (ast.NotEq, ast.NotIn),
            "strength": strength,
            "aspect": aspect,
            "subject": src(test.left, lines),
            "args": [make_arg(comparator, lines)],
            "subjectIdentifiers": identifiers_in(test.left),
        }

    # bare `assert value`
    return {
        "matcher": "truthy",
        "negated": False,
        "strength": "EXISTENCE",
        "aspect": "value",
        "subject": src(test, lines),
        "args": [],
        "subjectIdentifiers": identifiers_in(test),
    }


def assertions_in(fn, lines):
    out = []
    for node in ast.walk(fn):
        if isinstance(node, ast.Assert):
            info = classify_assert(node, lines)
            info["line"] = node.lineno
            info["raw"] = src(node, lines) or "assert ..."
            info["async"] = False
            info["subjectKey"] = "".join((info.get("subject") or "").split())
            out.append(info)
        elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            call = node.value
            f = call.func
            if isinstance(f, ast.Attribute) and f.attr in INTERACTION_METHODS:
                with_args = f.attr.endswith("_with")
                negated = f.attr == "assert_not_called"
                if negated:
                    strength = "EXISTENCE"
                elif with_args and call.args:
                    strength = "STRUCTURAL"
                else:
                    strength = "EXISTENCE"
                out.append({
                    "line": node.lineno,
                    "raw": src(node, lines) or f.attr,
                    "matcher": f.attr,
                    "negated": negated,
                    "async": False,
                    "strength": strength,
                    "aspect": "interaction",
                    "subject": src(f.value, lines),
                    "subjectKey": "".join(src(f.value, lines).split()),
                    "args": [make_arg(a, lines) for a in call.args],
                    "subjectIdentifiers": identifiers_in(f.value),
                })
    # pytest.raises context managers are error assertions.
    for node in ast.walk(fn):
        if isinstance(node, ast.With):
            for item in node.items:
                ctx = item.context_expr
                if isinstance(ctx, ast.Call):
                    f = ctx.func
                    name = f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", "")
                    if name == "raises":
                        has_match = any(k.arg == "match" for k in ctx.keywords)
                        first = ctx.args[0] if ctx.args else None
                        exc = src(first, lines) if first is not None else ""
                        if has_match:
                            strength = "CONSTRAINED"
                        elif exc in ("Exception", "BaseException", ""):
                            strength = "EXISTENCE"
                        else:
                            strength = "TYPE_ONLY"
                        out.append({
                            "line": node.lineno,
                            "raw": src(ctx, lines) or "pytest.raises(...)",
                            "matcher": "raises",
                            "negated": False,
                            "async": False,
                            "strength": strength,
                            "aspect": "error",
                            "subject": exc,
                            "subjectKey": "".join(exc.split()),
                            "args": [make_arg(a, lines) for a in ctx.args],
                            "subjectIdentifiers": identifiers_in(ctx),
                        })
    out.sort(key=lambda a: a["line"])
    return out


def modifier_of(fn):
    for dec in fn.decorator_list:
        target = dec.func if isinstance(dec, ast.Call) else dec
        parts = []
        cur = target
        while isinstance(cur, ast.Attribute):
            parts.append(cur.attr)
            cur = cur.value
        if isinstance(cur, ast.Name):
            parts.append(cur.id)
        joined = ".".join(reversed(parts))
        if "skip" in joined:
            return "skip"
        if "xfail" in joined:
            return "failing"
    return "none"


def calls_in(fn):
    out = []
    for n in ast.walk(fn):
        if isinstance(n, ast.Call):
            f = n.func
            if isinstance(f, ast.Name):
                out.append(f.id)
            elif isinstance(f, ast.Attribute):
                out.append(f.attr)
    seen, uniq = set(), []
    for x in out:
        if x not in seen and x not in ("assert", "isinstance"):
            seen.add(x)
            uniq.append(x)
    return uniq


# Helpers that verify by raising rather than through `assert`. The unittest
# assertion family is the main one; Django/Flask test clients and
# `pytest.fail`-style helpers behave the same way.
IMPLICIT_ASSERTION_NAMES = {
    "assertEqual", "assertNotEqual", "assertTrue", "assertFalse", "assertIs",
    "assertIsNot", "assertIsNone", "assertIsNotNone", "assertIn", "assertNotIn",
    "assertRaises", "assertRaisesRegex", "assertAlmostEqual", "assertDictEqual",
    "assertListEqual", "assertCountEqual", "assertRegex", "assertGreater",
    "assertLess", "fail", "assertContains", "assertRedirects",
    "assertQuerysetEqual", "assertNumQueries", "assertJSONEqual",
}


def implicit_assertions_in(fn, lines):
    out = []
    for n in ast.walk(fn):
        if isinstance(n, ast.Call):
            f = n.func
            name = f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", "")
            if name in IMPLICIT_ASSERTION_NAMES:
                out.append({"line": n.lineno, "api": name, "raw": src(n, lines)[:160]})
    return out


MOCK_APIS = ("patch", "Mock", "MagicMock", "AsyncMock", "patch.object", "monkeypatch")


def mock_ops_in(fn, lines):
    out = []
    for n in ast.walk(fn):
        if isinstance(n, ast.Call):
            f = n.func
            name = f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", "")
            if name in ("patch", "Mock", "MagicMock", "AsyncMock", "object", "setattr"):
                raw = src(n, lines)
                if name == "object" and "patch" not in raw:
                    continue
                if name == "setattr" and "monkeypatch" not in raw:
                    continue
                op = {"line": n.lineno, "raw": raw[:200], "api": name}
                if n.args and isinstance(n.args[0], ast.Constant) and isinstance(n.args[0].value, str):
                    op["moduleTarget"] = n.args[0].value
                out.append(op)
    return out


def parse_test(path, content):
    lines = content.split("\n")
    try:
        tree = ast.parse(content)
    except SyntaxError as e:
        return {"path": path, "framework": "pytest", "cases": [], "imports": [],
                "moduleMocks": [], "problems": [f"parse failed: {e}"]}

    imports = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                imports.append({"specifier": a.name, "names": [a.asname or a.name], "line": node.lineno})
        elif isinstance(node, ast.ImportFrom):
            spec = ("." * (node.level or 0)) + (node.module or "")
            imports.append({
                "specifier": spec if spec.startswith(".") else spec,
                "names": [a.name for a in node.names],
                "line": node.lineno,
            })

    cases = []

    def visit(node, suite_path, inherited):
        if isinstance(node, ast.ClassDef):
            nxt = suite_path + [node.name] if node.name.startswith("Test") else suite_path
            mod = modifier_of(node)
            for child in node.body:
                visit(child, nxt, mod if mod != "none" else inherited)
            return
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if not node.name.startswith("test"):
                return
            mod = modifier_of(node)
            effective = mod if mod != "none" else inherited
            asserts = assertions_in(node, lines)
            body_src = src(node, lines)
            implicit = implicit_assertions_in(node, lines)
            cases.append({
                "name": node.name,
                "fullName": " > ".join(suite_path + [node.name]),
                "line": node.lineno,
                "endLine": getattr(node, "end_lineno", node.lineno),
                "modifier": effective,
                "assertions": asserts,
                "body": body_src,
                "calls": calls_in(node),
                "mockOps": mock_ops_in(node, lines),
                "hasNoAssertions": len(asserts) == 0 and len(implicit) == 0,
                "implicitAssertions": implicit,
            })

    for node in tree.body:
        visit(node, [], "none")

    module_mocks = []
    for node in tree.body:
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            module_mocks.extend(mock_ops_in(node, lines))

    return {"path": path, "framework": "pytest", "cases": cases, "imports": imports,
            "moduleMocks": module_mocks, "problems": []}


COVERAGE_IGNORE_MARKERS = ("pragma: no cover", "pragma: nocover")
TEST_ENV_MARKERS = (
    "PYTEST_CURRENT_TEST", "pytest" , "TESTING", "IS_TEST", "__TEST__",
    "SKIP_VALIDATION", "BYPASS_AUTH",
)


def parse_production(path, content):
    lines = content.split("\n")
    signals = []
    for i, text in enumerate(lines, start=1):
        low = text.lower()
        if any(m in low for m in COVERAGE_IGNORE_MARKERS):
            signals.append({"line": i, "kind": "coverage-ignore", "text": text.strip()[:160]})
        if "environ" in text or "getenv" in text:
            if any(m.lower() in low for m in TEST_ENV_MARKERS):
                signals.append({"line": i, "kind": "test-environment-branch", "text": text.strip()[:160]})

    try:
        tree = ast.parse(content)
    except SyntaxError as e:
        return {"path": path, "signals": signals, "exportedNames": [],
                "returnExpressions": {}, "problems": [f"parse failed: {e}"]}

    exported = []
    returns = {}
    CMP_TEXT = {ast.Gt: ">", ast.GtE: ">=", ast.Lt: "<", ast.LtE: "<=",
                ast.Eq: "==", ast.NotEq: "!=", ast.Is: "is", ast.IsNot: "is not"}
    ARITH_TEXT = {ast.Add: "+", ast.Sub: "-", ast.Mult: "*", ast.Div: "/", ast.Mod: "%"}

    stack = []

    def walk(node):
        is_fn = isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
        if is_fn:
            stack.append(node.name)
            if not node.name.startswith("_"):
                exported.append(node.name)
        enclosing = stack[-1] if stack else None

        if isinstance(node, ast.Constant):
            v = node.value
            if isinstance(v, bool):
                signals.append({"line": node.lineno, "kind": "boolean-literal",
                                "text": "true" if v else "false", "enclosing": enclosing})
            elif isinstance(v, (int, float)):
                signals.append({"line": node.lineno, "kind": "numeric-literal",
                                "text": str(v), "numeric": v, "enclosing": enclosing})
            elif isinstance(v, str) and 0 < len(v) < 120:
                signals.append({"line": node.lineno, "kind": "string-literal",
                                "text": v, "enclosing": enclosing})
        elif isinstance(node, ast.Compare) and node.ops:
            op = type(node.ops[0])
            if op in CMP_TEXT:
                signals.append({"line": node.lineno, "kind": "comparison-operator",
                                "text": src(node, lines)[:160], "enclosing": enclosing})
        elif isinstance(node, ast.BoolOp):
            signals.append({"line": node.lineno, "kind": "logical-operator",
                            "text": "and" if isinstance(node.op, ast.And) else "or",
                            "enclosing": enclosing})
        elif isinstance(node, ast.BinOp) and type(node.op) in ARITH_TEXT:
            signals.append({"line": node.lineno, "kind": "arithmetic-operator",
                            "text": src(node, lines)[:160], "enclosing": enclosing})
        elif isinstance(node, ast.Return) and node.value is not None:
            raw = src(node.value, lines)[:200]
            signals.append({"line": node.lineno, "kind": "return-expression",
                            "text": raw, "enclosing": enclosing})
            if enclosing:
                returns.setdefault(enclosing, []).append(raw)
        elif isinstance(node, ast.If):
            signals.append({"line": node.lineno, "kind": "conditional",
                            "text": src(node.test, lines)[:200], "enclosing": enclosing})
        elif isinstance(node, ast.Raise) and node.exc is not None:
            signals.append({"line": node.lineno, "kind": "throw",
                            "text": src(node.exc, lines)[:200], "enclosing": enclosing})

        for child in ast.iter_child_nodes(node):
            walk(child)

        if is_fn:
            stack.pop()

    for child in ast.iter_child_nodes(tree):
        walk(child)

    return {"path": path, "signals": signals, "exportedNames": exported,
            "returnExpressions": returns, "problems": []}


def main():
    payload = json.loads(sys.stdin.read())
    kind = payload.get("kind", "test")
    path = payload["path"]
    content = payload["content"]
    if kind == "test":
        result = parse_test(path, content)
    else:
        result = parse_production(path, content)
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
