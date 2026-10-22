"""Offline proof of the CLI's `sessions.list_limit` resolver (local patch) — no CLI start needed.

Lifts `_configured_session_list_limit` out of `hermes_cli/cli_session_mixin.py` (importing that module
pulls in prompt_toolkit and the whole CLI) and drives it with a stubbed `hermes_cli.config`, so the
clamps and the defaults are checked against the real source text.

    python tools/verify_cli_session_limit.py [path/to/hermes-agent]
"""

import ast
import sys
import types
from pathlib import Path

HERMES = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r"C:/Users/roper/AppData/Local/hermes/hermes-agent")
SOURCE = HERMES / "hermes_cli" / "cli_session_mixin.py"


def resolver(config: dict):
    text = SOURCE.read_text(encoding="utf-8")
    tree = ast.parse(text)
    fn = next((n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_configured_session_list_limit"), None)
    assert fn is not None, "resolver missing from the source (patch not applied?)"
    module = types.ModuleType("hermes_cli.config")
    setattr(module, "load_config_readonly", lambda: config)
    sys.modules["hermes_cli.config"] = module
    body = ast.get_source_segment(text, fn)
    assert body, "could not read the resolver's source"
    ns: dict = {}
    exec(body, ns)  # noqa: S102 — the file under test, by design
    return ns["_configured_session_list_limit"]


def main() -> int:
    cases = [
        ("no sessions block", {}, 10),
        ("explicit 25", {"sessions": {"list_limit": 25}}, 25),
        ("a string still parses", {"sessions": {"list_limit": "40"}}, 40),
        ("zero clamps up", {"sessions": {"list_limit": 0}}, 1),
        ("huge clamps down", {"sessions": {"list_limit": 10_000}}, 500),
        ("garbage falls back", {"sessions": {"list_limit": "abc"}}, 10),
        ("null falls back", {"sessions": {"list_limit": None}}, 10),
    ]
    failed = 0
    for label, config, want in cases:
        try:
            got = resolver(config)()
        except Exception as exc:  # pragma: no cover - a raise is a failed case, not a crash
            got = f"{type(exc).__name__}: {exc}"
        ok = got == want
        failed += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'}  {label}: {got!r} (want {want!r})")
    print("RESULT: ALL PASS" if not failed else f"RESULT: {failed} FAILED")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
