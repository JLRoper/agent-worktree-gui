"""Offline proof of the gateway's run-usage projection — no gateway, no restart.

The gateway package drags in the whole platform stack (ruamel, aiohttp, …), which the interpreter
beside this checkout does not have, so the two functions under test are lifted straight out of the
patched source file and exec'd against the real ``agent.context_breakdown.context_usage_fields``.
What is checked is the file on disk, and one of its imports is the real one.

    python tools/probe_run_stats.py [path/to/hermes-agent]
"""

import ast
import json
import sys
from contextlib import suppress
from pathlib import Path
from typing import Any, Optional, Tuple  # noqa: F401 — referenced by the exec'd source

HERMES = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r"C:/Users/roper/AppData/Local/hermes/hermes-agent")
SOURCE = HERMES / "gateway" / "platforms" / "api_server_runs.py"


def _lift(name: str, text: str) -> str:
    """The source of one top-level function, up to the next top-level definition."""
    start = text.index(f"def {name}(")
    rest = text[start:]
    end = rest.find("\ndef ", 1)
    return rest if end < 0 else rest[: end + 1]


def _loaded():
    text = SOURCE.read_text(encoding="utf-8")
    tree = ast.parse(text)
    usage_fields = None
    for node in tree.body:
        if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "_USAGE_FIELDS":
            usage_fields = ast.literal_eval(node.value)
    assert usage_fields, "_USAGE_FIELDS not found in the gateway source"
    sys.path.insert(0, str(HERMES))
    from agent.context_breakdown import context_usage_fields

    namespace = {
        "Any": Any, "Optional": Optional, "Tuple": Tuple, "suppress": suppress,
        "_USAGE_FIELDS": usage_fields, "context_usage_fields": context_usage_fields,
    }
    for name in ("_run_stats", "_run_usage"):
        exec(_lift(name, text), namespace)  # noqa: S102 — the file under test, by design
    return namespace["_run_stats"], namespace["_run_usage"]


class Compressor:
    """The fields `agent.context_breakdown.context_usage_fields` reads."""

    last_prompt_tokens = 357_000
    last_real_prompt_tokens = 357_000  # a provider reading, not a preflight seed
    context_length = 1_000_000
    compression_count = 0


class LiveAgent:
    session_prompt_tokens = 120_000
    session_completion_tokens = 12_400
    session_total_tokens = 132_400
    session_cache_read_tokens = 118_800
    session_cache_write_tokens = 1_200
    context_compressor = Compressor()
    _api_latency_history = [3.9, 4.4, 4.3]   # seconds per API call
    _api_output_history = [870, 1_040, 990]  # output tokens per API call


class EstimatedAgent(LiveAgent):
    """A preflight-seeded compressor: the card must render the '~' mark."""

    class Compressor(Compressor):
        last_real_prompt_tokens = 300_000

    context_compressor = Compressor()


class BareAgent:
    """A test double with no counters and no compressor: nothing may crash, values are omitted."""


class ZeroCacheAgent(LiveAgent):
    session_cache_read_tokens = 0


class CompressedAgent(LiveAgent):
    class Compressor(Compressor):
        compression_count = 2

    context_compressor = Compressor()


def main() -> int:
    run_stats, run_usage = _loaded()
    cases = {
        "live": run_usage(LiveAgent()),
        "estimated": run_usage(EstimatedAgent()),
        "zero-cache": run_usage(ZeroCacheAgent()),
        "compressed": run_usage(CompressedAgent()),
        "bare": run_usage(BareAgent()),
        "stats-only": run_stats(BareAgent()),
    }
    for name, payload in cases.items():
        print(f"{name:12}: {json.dumps(payload, sort_keys=True)}")

    live, est, zero, comp, bare = (cases[k] for k in ("live", "estimated", "zero-cache", "compressed", "bare"))
    checks = [
        ("counters survive the merge", live["total_tokens"] == 132_400),
        ("context occupancy", (live["context_used"], live["context_max"], live["context_percent"]) == (357_000, 1_000_000, 36)),
        ("a provider reading is not marked estimated", live["context_estimated"] is False),
        ("a seeded reading is", est["context_estimated"] is True),
        ("cache hit rate", live["cache_hit_pct"] == 99.0),
        ("no cache reads -> no percentage, not 0", "cache_hit_pct" not in zero),
        ("latency is the mean of the calls", live["avg_latency_s"] == 4.2),
        ("throughput is sum(out)/sum(latency)", live["avg_tps"] == 230.2),
        ("compressions only when there were some", comp["compressions"] == 2),
        (
            "nothing numeric, nothing invented",
            bare == {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0,
                     "cache_read_tokens": 0, "cache_write_tokens": 0},
        ),
        ("the stats-only projection of a bare agent is empty", cases["stats-only"] == {}),
    ]
    failed = 0
    for label, ok in checks:
        print(f"{'PASS' if ok else 'FAIL'}  {label}")
        failed += 0 if ok else 1
    print("RESULT: ALL PASS" if not failed else f"RESULT: {failed} FAILED")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
