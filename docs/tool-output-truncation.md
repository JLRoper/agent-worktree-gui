# Where a tool result gets cut, and what raises the cap

A worker's card shows a tool result as a header plus a couple of lines. That is not the console losing
text — it is text that never arrived. This note is the measurement: which layer sets the limit, the two
env-only knobs that raise it, the numbers, and the seam the console work has to know about.

Measured on this box, 2026-10-26, gateway `0.22.2` (`code_sha 5f5c9e92f5ab1219a2bb8049b41fff1aed183f6a`),
against a 400-line / 43,892-byte file read with one `read_file`.

## The boundary the panel actually reads: the Runs API's `tool.completed.preview`

`lib/jobs.js:203` says *"result truncated by the gateway"*, and the gateway is exactly right. A job is an
HTTP run (`docs/runs-api-phase1.md`), so the result reaches the panel as the `preview` field of the SSE
`tool.completed` event, and that field is capped at **500 characters**:

`gateway/platforms/api_server_runs.py`

```python
 98  _DEFAULT_TOOL_COMPLETED_PREVIEW_MAX_CHARS = 500
...
101  def _tool_preview_max_chars() -> int:
102      """HERMES_RUN_PREVIEW_CHARS raises the run-stream preview cap; 0 (or negative) = full output."""
103      raw = os.environ.get("HERMES_RUN_PREVIEW_CHARS", "").strip()
104      if not raw:
105          return _DEFAULT_TOOL_COMPLETED_PREVIEW_MAX_CHARS
...
112  def _tool_completed_preview(result: Any, redact_sensitive_text: Callable[..., str]) -> str:
113      """Bounded, secret-redacted result summary for the public run stream — redacted BEFORE
114      truncation so a cut never leaves a secret's prefix on the wire."""
...
119      limit = _tool_preview_max_chars()
120      return preview if limit <= 0 or len(preview) <= limit else preview[: limit - 3] + "..."
```

Wired in at `api_server_runs.py:354` (`event_fields["preview"] = _tool_completed_preview(kwargs.get("result"), …)`).

So the cut is `preview[:497] + "..."` — 500 characters, minus the marker, ending mid-line, mid-string.
That is why a 46-line `patch` on `AGENTS.md` arrives as a header plus two lines.

## The boundary on the CLI spawn path the card named

The card described the panel as spawning `hermes chat -q -w -Q --format stream-json`. It no longer does
(`lib/jobs.js:1-25`; `docs/runs-api-phase1.md`), but that path still exists on this box and carries its
own, different cap — **5,000 characters**:

`hermes_cli/stream_json.py`

```python
 16  # Tool results in the JSONL stream are capped so one runaway command cannot bloat an orchestrator's
 17  # log. HERMES_STREAM_TOOL_CAP raises the cap; 0 (or any non-positive value) streams the full result.
 19  _DEFAULT_TOOL_OUTPUT_CAP = 5000
...
 22  def _tool_output_cap() -> int:
 23      raw = os.environ.get("HERMES_STREAM_TOOL_CAP", "").strip()
...
 35  def _capped_tool_output(output: str) -> str:
 36      cap = _TOOL_OUTPUT_CAP
 37      return output if cap <= 0 or len(output) <= cap else output[:cap] + "..."
```

Emitted at `stream_json.py:101` (`"output": _capped_tool_output(output)`). Both caps are the same shape
and the same marker; they are different numbers and different env vars.

## The panel's own cap is a third one, and it is smaller than the card suggests

Even a raised gateway cap does not put the whole block in the card body, because `lib/jobs.js` cuts it
again for display:

```javascript
175  const MAX_TOOL_LINES = 40;
176  const MAX_TOOL_LINE_CHARS = 400;
197    const shown = all.slice(0, MAX_TOOL_LINES).map((l) => l.slice(0, MAX_TOOL_LINE_CHARS));
200    if (all.length > shown.length) out.push({ kind: "tool-out", text: `… ${all.length - shown.length} more line(s)` });
203    if (unwrapped.truncated) out.push({ kind: "tool-out", text: "… result truncated by the gateway — the live stream carries a preview of a tool result, not all of it" });
```

And `truncated` is not a field on the wire — the panel infers it, from whether the payload ends like
JSON should:

```javascript
// lib/tool-text.js:80-81
// A payload that ends with a quote or a brace arrived whole; anything else was cut mid-string by the gateway.
const cut = !/["}]\s*$/.test(text);
```

## The knobs: two env vars, no config key, and a gateway restart

Both are read from `os.environ` **at call time**, so neither needs a code change — only a process that
has the variable.

| path | default cap | knob | where to set it |
|---|---|---|---|
| Runs API SSE (`tool.completed.preview`) — **the panel's path** | 500 | `HERMES_RUN_PREVIEW_CHARS` (`0` = full) | the gateway's environment |
| `hermes chat --format stream-json` (`tool_result.output`) | 5000 | `HERMES_STREAM_TOOL_CAP` (`0` = full) | the spawning process's environment |

There is **no `config.yaml` key** for either. Two near-misses, so the next reader does not chase them:

* `display.tool_preview_length` (`hermes_cli/config_defaults.py:929`) caps the tool **call** preview — the
  arguments shown on `tool.started` — not the result.
* `gateway.api_server.history_tool_output_max_chars` (`config_defaults.py:2242`, currently `0` = verbatim)
  caps the tool output **stored and replayed** on the OpenAI-compatible routes, not the SSE preview.

The gateway on this box is launched by `gateway-service/Hermes_Gateway.cmd`:

```bat
set "HERMES_HOME=C:\Users\Jacob\AppData\Local\hermes"
set "PYTHONPATH=C:\Users\Jacob\AppData\Local\hermes\hermes-agent;%PYTHONPATH%"
C:\Users\Jacob\AppData\Local\hermes\tools\python-3.14.7+…\python.exe -m hermes_cli.main gateway run
```

Either add `set "HERMES_RUN_PREVIEW_CHARS=0"` to that file, or — the tidier place, and the one that
survives the file being regenerated — add `HERMES_RUN_PREVIEW_CHARS=0` to `$HERMES_HOME/.env`. That file
is loaded into `os.environ` with `override=True` before the gateway starts
(`hermes_cli/env_loader.py:505-506`, called from `hermes_cli/main.py:714`), so a value there wins over a
shell value.

**It needs a gateway restart.** A live process's environment cannot be changed; the function re-reads
`os.environ` on every event, so nothing else is required — no patch, no config write. (Note for the
panel: if the panel restarts the gateway it spawns it with `{ ...process.env, HERMES_HOME }`
(`lib/restart.js:467`), so a variable in the *panel's* environment is inherited by the gateway it
starts.) `0` is the value to use; a positive number is a smaller cap, and `0` costs nothing extra in the
agent's own context, which was never capped.

## The numbers

One `read_file` of a 400-line / 43,892-byte file, through both paths:

| path | cap in effect | received | cut? |
|---|---|---|---|
| `hermes chat -q -w -Q --format stream-json` | default | **5,003 chars** (11.4%) | yes — ends `…line 45 of the tool-outp...` |
| the same, `HERMES_STREAM_TOOL_CAP=0` | off | **45,916 chars** | no — ends `"not_found": false}` |
| Runs API SSE `tool.completed.preview` | default | **500 chars** (1.1%) | yes — ends `…line 5 of the tool-output cap pr...` |
| `_tool_completed_preview` with `HERMES_RUN_PREVIEW_CHARS=0` | off | **full payload** | no |
| `state.db` `messages.content` (stored) | — | **43,916 chars** | no |

The raw `tool_result` event on the CLI path, trimmed to what proves it (`output` cut from 5,003 chars):

```json
{"type":"tool_result","name":"read_file","output":"{\"content\": \"1|0001  line 1 of the tool-output cap probe: 01   <<<CUT>>>   lmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ\\n45|0045  line 45 of the tool-outp...","duration_ms":2144,"is_error":false,"timestamp":1792995516578}
```

The raw SSE event the panel reads, `preview` cut from 500 chars (`run_0f13d3536e834a2a9c9343d2b74e8c5c`):

```json
{"event":"tool.completed","run_id":"run_0f13d3536e834a2a9c9343d2b74e8c5c","timestamp":1792995527.2415652,"tool":"read_file","duration":1.889,"error":false,"preview":"{\"content\": \"1|0001  line 1 of the tool-output cap probe: 01   <<<CUT>>>   stuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ\\n5|0005  line 5 of the tool-output cap pr...","seq":1}
```

Note the difference the two caps make on the same file: 5 lines survive on the panel's path, 45 on the
CLI's.

Re-measure after any gateway change with `node tools/measure-tool-output-cap.mjs` (`--runs` for the
panel's path, `--cap 0` to see the knob take effect, `--worktree` for the old `-w` spawn).

## The full text is already on this box

Every result is stored verbatim — `state.db`, `messages.content`, `role='tool'`, 43,916 chars for the read
above — and the panel already knows how to read it back: `lib/tool-results.js` selects the turn's tool rows
by `session_id`/`tool_name`/timestamp window, unwraps them with the same `unwrapToolText`, and caps at its
own `maxChars` (6,000) with an explicit `… N characters not shown` marker. So the live stream being a
preview is not a data-loss problem, and nothing here needs a transcript reader built from scratch.

## What was set, and where (this card)

`HERMES_RUN_PREVIEW_CHARS=0` is now durable in the two places a NEW gateway process reads, and the built-in
default (500) is never reached:

| place | what it says | who reads it |
|---|---|---|
| `$HERMES_HOME/.env` (`C:\Users\Jacob\AppData\Local\hermes\.env`) | `HERMES_RUN_PREVIEW_CHARS=0` | every Hermes process at boot — `hermes_cli/main.py:714` calls `load_hermes_dotenv()`, which loads `$HERMES_HOME/.env` with **`override=True`** (`hermes_cli/env_loader.py:505`), so it also beats a stale value inherited from the shell |
| `HKCU\Environment` | `HERMES_RUN_PREVIEW_CHARS=0` (`REG_SZ`) | any new process started from the user environment (it held `20000` before this card — a 20,000-char cap, still a cut) |

Proof that a new process picks it up, without restarting anything (the shell is given a deliberately WRONG value,
which `.env` must beat):

```
cd C:/Users/Jacob/AppData/Local/hermes
HERMES_HOME='C:\Users\Jacob\AppData\Local\hermes' \
PYTHONPATH='C:\Users\Jacob\AppData\Local\hermes\hermes-agent;<the unpacked wheels under cache/uv/archive-v0>' \
HERMES_RUN_PREVIEW_CHARS=20000 tools/python-*/python.exe -c \
"import os; from hermes_cli.env_loader import load_hermes_dotenv; load_hermes_dotenv(); \
 from gateway.platforms.api_server_runs import _tool_preview_max_chars, _tool_completed_preview; \
 print(os.environ['HERMES_RUN_PREVIEW_CHARS'], _tool_preview_max_chars(), \
 len(_tool_completed_preview({'output':'x'*100000}, lambda t, force=False: t)))"
→ 0 0 100014
```

and the value itself: `grep -n HERMES_RUN_PREVIEW_CHARS "$HERMES_HOME/.env"` (0) plus
`reg query "HKCU\Environment" /v HERMES_RUN_PREVIEW_CHARS` (0). `tools/measure-tool-output-cap.mjs --runs` is
the live measurement of whatever the running gateway is actually doing.

**Do not restart the gateway to test this**: a restart cuts every `/v1` run in flight. The live gateway on this
box was measured already streaming the whole payload (`--runs`: 45,916 chars for a 43,892-byte read, uncut), so
the setting only has to make that survive the next restart — before this card, a restart would have picked
`20000` (or `500`) back up, which is the cut the reader was looking at.

## The other half: the panel's own fold, and the click that opens it

With the preview cap gone the whole result arrives, and the binding limit becomes the panel's own: `MAX_TOOL_LINES`
(40) / `MAX_TOOL_LINE_CHARS` (400) against the console's ring buffer (`lib/jobs.js` `MAX_LINES = 600`). That fold
is now **explicit and clickable**:

- it ends with `… N lines hidden — click to read` (or `… N lines hidden, M lines shortened — click to read` when a
  head line wore the 400-character cap), pushed as a normal console line by `lib/jobs/console-lines.js`;
- `public/core/console-format.js` draws that line as a button carrying the turn, the tool and **which row** of that
  turn's results it is;
- the click asks `/api/tool-results?row=<i>&full=1` for exactly that one row — `lib/tool-results.js` gained an
  `index` (SQL `LIMIT 1 OFFSET i`) and treats `maxChars: 0` as uncapped — and the burst is redrawn with the whole
  text in place. Nothing is appended to the job's lines, so a 5,000-line result never enters the 600-line ring
  buffer, and the opened row is remembered (`state.foldRows`) so a repaint does not fold it back shut;
- each note appears only when its own cap really cut something, and each names that cap: the gateway's sentence for
  the gateway's preview, this sentence for the panel's fold.

Measured on this box's own store (`node tools/measure-whole-tool-stream.mjs`): the largest stored tool result is
**102,936 bytes** (a `read_file`); at the old 500-char cap the panel received 500 bytes and drew 10 console lines,
at 20,000 it received 20,000 bytes and drew 43 lines, and with the cap lifted it receives all 102,936 bytes and
still draws **42 lines** (40 of head, plus the fold note). The ring buffer survives every case — that is the point
of the fold. `node tools/measure-whole-tool-stream.mjs --volume` has the affordability numbers: 25,010 results,
62.8 MB, mean 2.6 kB, 74% of rows longer than 500 characters holding 97% of the bytes.

`tools/verify-whole-tool-stream.mjs` drives all of it (the two caps by their own code, the store row selection, and
the fold-and-fetch in a real browser); the older `tools/verify-console-*.mjs` suites stay green.
