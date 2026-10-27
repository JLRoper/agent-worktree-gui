#!/usr/bin/env python3
"""Look up OpenRouter model prices (USD per million tokens) and a 0-10 rating, then write the JSON
the model picker reads.

Three sources:

  * https://openrouter.ai/api/v1/models - live list + per-token pricing. The authority for price and
    for "what exists on OpenRouter right now".
  * https://artificialanalysis.ai/leaderboards/models - the Intelligence Index (0-100), a public
    composite benchmark score. Divided by 10 for the 0-10 rating. Only models they have actually
    benchmarked get a rating; the rest are written as null rather than invented.
  * $HERMES_HOME/provider_models_cache.json - the models the gateway's provider list actually offers
    (the same list /api/models serves), so the panel can mark which rows a run can really pick.

Prices arrive as USD per *token*; everything written here is per *million* tokens. `average` is the
mean of input and output, the number people quote when comparing models.

Zero dependencies: Python 3 stdlib only. Re-run any time; output is deterministic given the API reply.

    python tools/openrouter-prices.py                 # panel models first, plus newest on OpenRouter
    python tools/openrouter-prices.py --all           # every model OpenRouter advertises
    python tools/openrouter-prices.py --newest 40     # size of the "latest models" list
    python tools/openrouter-prices.py --no-ratings    # prices only; keep ratings already in the file
    python tools/openrouter-prices.py --out data/x.json

Exit codes: 0 ok, 2 OpenRouter fetch failure (nothing written, previous file left alone). A failed
Artificial Analysis fetch is not fatal: prices still update and the previous ratings are kept.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

API = "https://openrouter.ai/api/v1/models"
RATINGS_API = "https://artificialanalysis.ai/leaderboards/models"
DEFAULT_OUT = "data/openrouter-model-prices.json"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) agent-worktree-gui/openrouter-prices"


def hermes_home() -> Path:
    env = os.environ.get("HERMES_HOME")
    if env:
        return Path(env)
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA")
        if local:
            return Path(local) / "hermes"
        return Path.home() / "AppData" / "Local" / "hermes"
    return Path.home() / ".hermes"


def fetch_models(api_key: str | None, timeout: float = 60.0) -> dict:
    req = urllib.request.Request(API, headers={"Accept": "application/json", "User-Agent": UA})
    if api_key:
        req.add_header("Authorization", f"Bearer {api_key}")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def per_million(value) -> float | None:
    """OpenRouter prices are strings of USD per token. -1 means 'varies' (routers)."""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n < 0:
        return None
    return round(n * 1_000_000, 6)


def panel_models(home: Path) -> list[str]:
    path = home / "provider_models_cache.json"
    try:
        cache = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    entry = cache.get("openrouter") if isinstance(cache, dict) else None
    models = entry.get("models") if isinstance(entry, dict) else None
    return [m for m in (models or []) if isinstance(m, str)]


# ---- ratings: Artificial Analysis Intelligence Index / 10 ----------------------------------------
# Their leaderboard is a Next.js page; the full model table rides in the flight payload as
# `"initialModels":[...]`. Parsing that is more stable than the rendered HTML and needs no API key
# (their JSON API answers 401 without one).

VENDOR_PREFIX = re.compile(
    r"^(nvidia|google|meta|microsoft|amazon|anthropic|openai|alibaba|baidu|bytedance|tencent|"
    r"mistral|cohere|ai21|databricks|snowflake|ibm|salesforce|nous|minimax|moonshot|zhipu|z-ai|"
    r"xiaomi|stepfun|upstage|poolside|thinkingmachines|sakana|inception|reflection|liquid|arcee|"
    r"perplexity|x-ai|deepseek|qwen)-"
)


def _norm(value: str) -> str:
    s = str(value or "").lower()
    s = re.sub(r"\([^)]*\)", " ", s)            # reasoning-effort qualifiers
    s = s.replace(":free", "")                   # must precede the vendor strip: ":free" is not "Vendor:"
    s = re.sub(r"^[^:]+:\s+", "", s)             # "DeepSeek: " vendor prefix in names (space required)
    s = re.sub(r"^[a-z0-9.\-]+/", "", s)         # "deepseek/" provider prefix in ids
    s = re.sub(r"-(contributor|ultraspeed)$", "", s)  # OpenRouter pricing/speed labels, same weights
    s = re.sub(r"[^a-z0-9.]+", "-", s).strip("-")
    s = s.replace(".", "-")
    return re.sub(r"-+", "-", s)


def _undated(slug: str) -> str:
    """`...-20261017` / `...-0902` snapshots are the same family; stripping the date lets the
    undated OpenRouter alias meet the dated benchmark row."""
    return re.sub(r"-\d{4}$", "", slug)


def fetch_ratings(timeout: float = 60.0) -> list[dict]:
    req = urllib.request.Request(RATINGS_API, headers={"Accept": "text/html", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        html = r.read().decode("utf-8", "ignore")
    chunks = [json.loads(m.group(1)) for m in re.finditer(r'self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)', html)]
    payload = "".join(chunks)
    marker = '"initialModels":'
    start = payload.find(marker)
    if start < 0:
        raise ValueError("initialModels not found in leaderboard payload")
    models, _ = json.JSONDecoder().raw_decode(payload[start + len(marker):])
    if not isinstance(models, list):
        raise ValueError("initialModels is not a list")
    return models


def build_rating_index(models: list[dict]) -> tuple[dict, dict]:
    by_slug: dict[str, list[dict]] = {}
    by_name: dict[str, list[dict]] = {}
    for m in models:
        index = m.get("intelligenceIndex")
        if index is None:
            continue
        entry = {
            "rating": round(float(index) / 10, 1),
            "slug": m.get("slug"),
            "name": m.get("name"),
            "estimated": bool(m.get("intelligenceIndexIsEstimated")),
        }
        slug = _norm(m.get("slug") or "")
        bare = VENDOR_PREFIX.sub("", slug)
        for key in {slug, _undated(slug), bare, _undated(bare)}:
            if key:
                by_slug.setdefault(key, []).append(entry)
        name = _undated(_norm(m.get("name") or ""))
        for key in {name, VENDOR_PREFIX.sub("", name)}:
            if key:
                by_name.setdefault(key, []).append(entry)
    return by_slug, by_name


def lookup_rating(model_id: str, name: str, by_slug: dict[str, list[dict]], by_name: dict[str, list[dict]]) -> tuple[dict | None, str | None]:
    """Exact id first, then the undated id, then an unambiguous name match. No prefix guessing: a
    Kimi K3 is not a K3.1, and a Sonnet 5 is not a Sonnet 5.5."""
    slug = _norm(model_id)
    for key in (slug, _undated(slug)):
        hits = by_slug.get(key)
        if hits:
            return max(hits, key=lambda h: float(h["rating"])), "id"
    named = by_name.get(_undated(_norm(name)))
    if named and len({h["slug"] for h in named}) == 1:
        return named[0], "name"
    return None, None


def fetch_page_rating(model_id: str, timeout: float) -> dict | None:
    """The leaderboard omits retired/deprecated models, but their own model page still carries the
    score. One request per unrated panel model, cached for a week."""
    slug = _norm(model_id)
    if not slug:
        return None
    url = f"https://artificialanalysis.ai/models/{slug}"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "RSC": "1", "Accept": "text/x-component"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            page = r.read().decode("utf-8", "ignore")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
        return None
    # The flight payload escapes its quotes; unescape once, then read the page's OWN object.
    # Comparison tables on the page carry other models' scores, so anchor on "currentModel" and stop
    # at the next "slug" - otherwise a sibling's score gets attached to this model (gpt-5.5-pro
    # reported 0.7 from a 6.7 comparison row before this fix).
    text = page.replace('\\"', '"')
    anchor = text.find('"currentModel"')
    scope = text[anchor:anchor + 12000] if anchor >= 0 else text
    at = scope.find(f'"slug":"{slug}"')
    if at < 0:
        return None
    # Nested enums also carry "slug" keys ("max", "high"), so do not cut at the next slug. The first
    # intelligenceIndex after the model's own slug is its own (null when they have not scored it).
    segment = scope[at:at + 8000]
    m = re.search(r'"intelligenceIndex":\s*(null|-?[0-9.]+)', segment)
    if not m or m.group(1) == "null":
        return None
    est = re.search(r'"intelligenceIndexIsEstimated":\s*(true|false)', segment)
    return {
        "rating": round(float(m.group(1)) / 10, 1),
        "slug": slug,
        "name": None,
        "estimated": bool(est and est.group(1) == "true"),
        "at": int(time.time()),
    }


def load_page_cache(path: Path) -> dict[str, dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data.get("models") or {} if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_page_cache(path: Path, models: dict[str, dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps({"generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "models": models}, indent=1), encoding="utf-8")
    tmp.replace(path)


def apply_rating(target: dict, hit: dict, source: str) -> None:
    target["rating"] = hit["rating"]
    target["ratingSource"] = source
    target["ratingModel"] = hit.get("slug")
    target["ratingEstimated"] = hit.get("estimated")


def previous_ratings(path: Path) -> dict[str, dict]:
    """Reuse the ratings already written when the benchmark fetch fails, so a network blip does not
    silently downgrade the whole board to unrated."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    out = {}
    for entry in data.get("models") or []:
        if entry.get("id") and entry.get("rating") is not None:
            out[entry["id"]] = {k: entry.get(k) for k in ("rating", "ratingSource", "ratingModel", "ratingEstimated")}
    return out


def row(m: dict, panel: set[str], by_slug: dict[str, list[dict]], by_name: dict[str, list[dict]], kept: dict[str, dict]) -> dict:
    p = m.get("pricing") or {}
    top = m.get("top_provider") or {}
    arch = m.get("architecture") or {}
    inp = per_million(p.get("prompt"))
    out = per_million(p.get("completion"))
    avg = round((inp + out) / 2, 6) if inp is not None and out is not None else None
    hit, _how = lookup_rating(m.get("id") or "", m.get("name") or "", by_slug, by_name)
    if hit:
        rating = {
            "rating": hit["rating"],
            "ratingSource": "artificialanalysis.ai/leaderboards/models",
            "ratingModel": hit["slug"],
            "ratingEstimated": hit["estimated"],
        }
    else:
        rating = kept.get(m.get("id") or "", {})
    return {
        "id": m.get("id"),
        "name": m.get("name"),
        "created": m.get("created"),
        "added": datetime.fromtimestamp(m["created"], tz=timezone.utc).strftime("%Y-%m-%d") if m.get("created") else None,
        "contextLength": m.get("context_length"),
        "maxCompletionTokens": top.get("max_completion_tokens"),
        "inputPerMillion": inp,
        "outputPerMillion": out,
        "averagePerMillion": avg,
        "cacheReadPerMillion": per_million(p.get("input_cache_read")),
        "variablePricing": inp is None and out is None,
        "modality": arch.get("modality"),
        "inPanel": m.get("id") in panel,
        "rating": rating.get("rating"),
        "ratingSource": rating.get("ratingSource"),
        "ratingModel": rating.get("ratingModel"),
        "ratingEstimated": rating.get("ratingEstimated"),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=DEFAULT_OUT, help=f"output JSON path (default {DEFAULT_OUT})")
    ap.add_argument("--all", action="store_true", help="include every OpenRouter model, not just the panel's")
    ap.add_argument("--newest", type=int, default=25, help="how many newest models to list (default 25)")
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--no-ratings", action="store_true", help="skip the ratings fetch and keep the ratings already in the file")
    ap.add_argument("--no-deep-ratings", action="store_true", help="do not fetch per-model pages for panel models missing from the leaderboard")
    args = ap.parse_args(argv)

    out = Path(args.out)
    if not out.is_absolute():
        out = Path(__file__).resolve().parent.parent / out

    key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENAI_API_KEY")
    try:
        payload = fetch_models(key, args.timeout)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError) as e:
        print(f"openrouter-prices: fetch failed: {e}", file=sys.stderr)
        return 2

    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        print("openrouter-prices: unexpected API shape (no data[])", file=sys.stderr)
        return 2

    home = hermes_home()
    panel = panel_models(home)
    panel_set = set(panel)
    prior: dict[str, dict] = {}

    by_slug: dict = {}
    by_name: dict = {}
    ratings_note = None
    if args.no_ratings:
        # Explicit "prices only": keep whatever ratings the file already had.
        prior = previous_ratings(out)
    else:
        try:
            by_slug, by_name = build_rating_index(fetch_ratings(args.timeout))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, json.JSONDecodeError) as e:
            prior = previous_ratings(out)
            ratings_note = f"ratings fetch failed ({e}); kept ratings already in {out.name}"
            print(f"openrouter-prices: {ratings_note}", file=sys.stderr)

    rows = [row(m, panel_set, by_slug, by_name, prior) for m in data if m.get("id")]
    by_id = {r["id"]: r for r in rows}

    # The leaderboard omits retired/deprecated models; their individual pages still carry the score.
    # Panel models only (bounded cost), cached for a week so a re-run costs nothing.
    deep_fetched = 0
    deep_note = None
    if not args.no_deep_ratings and not args.no_ratings:
        cache_path = out.with_name("aa-rating-pages.json")
        cache = load_page_cache(cache_path)
        now = time.time()
        todo = []
        for r in rows:
            if not r["inPanel"] or r["rating"] is not None:
                continue
            hit = cache.get(r["id"])
            if hit and hit.get("rating") is not None and now - float(hit.get("at") or 0) < 7 * 86_400:
                apply_rating(r, hit, "artificialanalysis.ai/models/" + str(hit.get("slug") or _norm(r["id"])))
            else:
                todo.append(r)
        if todo:
            try:
                with ThreadPoolExecutor(max_workers=6) as pool:
                    results = list(pool.map(lambda item: fetch_page_rating(item["id"], args.timeout), todo))
                for r, hit in zip(todo, results):
                    if hit:
                        apply_rating(r, hit, "artificialanalysis.ai/models/" + str(hit["slug"]))
                        cache[r["id"]] = hit
                        deep_fetched += 1
                save_page_cache(cache_path, cache)
            except Exception as e:  # noqa: BLE001 - a ratings extra must never lose the price data
                deep_note = f"deep ratings failed ({e})"
                print(f"openrouter-prices: {deep_note}", file=sys.stderr)

    kept = [r for r in rows if r["inPanel"]] if not args.all else rows
    kept.sort(key=lambda r: (r["averagePerMillion"] is None, r["averagePerMillion"] if r["averagePerMillion"] is not None else 0, r["id"]))

    newest = sorted((r for r in rows if r.get("created")), key=lambda r: r["created"], reverse=True)[: max(0, args.newest)]

    missing = [m for m in panel if m not in by_id]
    payload_out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": API,
        "apiTotalCount": payload.get("total_count", len(rows)),
        "panelCache": str(home / "provider_models_cache.json"),
        "panelCount": len(panel),
        "currency": "USD",
        "unit": "per 1M tokens",
        "note": "input/output/average are USD per million tokens; null means OpenRouter advertises variable pricing (-1), as for router ids.",
        "ratings": {
            "source": RATINGS_API,
            "unit": "0-10 (Artificial Analysis Intelligence Index / 10)",
            "ratedPanelModels": len([r for r in kept if r["rating"] is not None]),
            "panelModels": len(kept),
            "note": "Only models Artificial Analysis has benchmarked get a rating; null means unrated, not zero. ratingEstimated marks their own estimated scores.",
            "warning": ratings_note,
            "deepFetched": deep_fetched,
            "deepWarning": deep_note,
        },
        "counts": {
            "onOpenRouter": len(rows),
            "inPanel": len([r for r in rows if r["inPanel"]]),
            "panelMissingFromOpenRouter": len(missing),
        },
        "models": kept,
        "latestModels": newest,
        "panelModelsMissingFromOpenRouter": missing,
    }

    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".tmp")
    tmp.write_text(json.dumps(payload_out, indent=1) + "\n", encoding="utf-8")
    tmp.replace(out)

    # Readable summary: id, in, out, average, 0-10 rating.
    print(f"{'model':50} {'in/M':>8} {'out/M':>8} {'avg/M':>8} {'rating':>7}")
    print("-" * 88)
    for r in kept:
        fmt = lambda v: "variable" if v is None else f"{v:g}"
        rating = "—" if r["rating"] is None else f"{r['rating']:g}"
        print(f"{r['id'][:50]:50} {fmt(r['inputPerMillion']):>8} {fmt(r['outputPerMillion']):>8} {fmt(r['averagePerMillion']):>8} {rating:>7}")
    print("-" * 88)
    print(f"{len(kept)} models written to {out} ({payload_out['counts']}); rated {payload_out['ratings']['ratedPanelModels']}/{len(kept)}")
    if missing:
        print(f"panel models no longer advertised by OpenRouter ({len(missing)}): {', '.join(missing)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
