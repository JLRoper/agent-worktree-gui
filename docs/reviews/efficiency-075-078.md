# Efficiency review — the 0.75.0 → 0.78.1 delta

**Scope.** `git diff 35b3c82..fd36130` in full: 17 commits, 45 files, +4 687 / −139. Of that, 16 files are
production code (+1 581 / −109); the rest is documentation, tests and verification harnesses. Every hunk that
runs per refresh, per streamed row or per tick was judged for cost, and the six named patterns were hunted
explicitly: an interval/timeout/listener with no clear, an unbounded array or DOM append, a render inside a
render, a regex or `JSON.parse` in a hot loop, a per-item shell-out or network call, and a per-row re-read of
the job store or a repo rescan.

**Snapshot.** Branch `wtgui/review-the-0-75-0-0-78-1-b0b34f`, HEAD `fd36130`, clean tree. Line numbers are this
tree's at that commit. `wc -l` on the files cited: `public/app.js` 16 800+, `public/assistant.js` 3 500+,
`lib/assistant/queue.js` 1 200+, `lib/base-ref.js` 79, `public/core/console-markdown.js` 457.

**Method.** Read, not measured. Nothing was started, no server was booted, no browser was driven, and no
benchmark was run — so every cost below is a mechanism traced through the code, not an observed millisecond
figure. Where a number appears it is either a constant read out of the source (`MAX_LINES = 600`,
`REMOTES_TTL_MS = 60_000`, `MAX_CONSUMED = 20`, `CONSOLE_MD_FENCE_FOLD = 15`) or a count of call sites and
regex passes. The one thing this review does *not* do is claim which of these is the reader's drag; it ranks
them by how much of a drag each *could* explain and says where the answer is "none of them".

---

## Verdict

The delta is, on the whole, careful about cost. It adds no timer, no listener and no `JSON.parse` to any hot
path; the one animation loop it introduces is cancelled on both release paths and self-terminates; the one new
cache it introduces is TTL'd and bounded; and the one new ledger it introduces is capped at 20 entries. Of the
six hunted patterns, the timer/listener one comes back wholly clean (see "Where the delta is clean"), and the
others each produce at most two findings.

What it does add is **one genuine O(rows²) on a per-streamed-row path** — the raw console view re-joins and
re-writes the whole turn's text for every line that arrives (`public/app.js:9543`) — and **one per-row process
spawn** that is cached on success but not on failure and not deduped in flight (`lib/base-ref.js:31`). Those
are the only two findings that could plausibly account for a visible drag. Of the remaining six, one is a
deliberate trade (E8, an extra round trip per refused steer), one is a slow leak (E5), and four are bounded by
a constant or a line length and cannot explain a drag at all.

The single most useful sentence in this report: **if the reader's complaint is a long turn dragging, the raw
view being on is the first thing to check, and `git remote` failing in a project checkout is the second.**

---

## Numbers

| thing | value | how |
|---|---|---|
| commits in the delta | 17 | `git log --oneline 35b3c82..fd36130 \| wc -l` |
| files / added / deleted | 45 / +4 687 / −139 | `git diff --numstat` |
| production files / added / deleted | 16 / +1 581 / −109 | same, over `lib public server.js config.json package.json` |
| new production modules | 3 (`lib/base-ref.js` 79, `public/core/console-markdown.js` 457, `public/core/steerable.js` 82) | `git diff --stat` |
| new `setInterval` / `setTimeout` / `addEventListener` in production code | 0 | grep of the delta's `+` lines |
| new `requestAnimationFrame` loops | 1, cancelled on `pointerup` and `pointercancel` | `public/assistant.js:2584`, `:2640`, `:3460-3461` |
| new `JSON.parse` in production code | 0 (all 7 additions are in `test/` and `tools/`) | grep of the delta's `+` lines |
| regex passes per line in `consoleMdInline` | 11 (1 escape + 10 `replace`) | `public/core/console-markdown.js:102-129` |
| regex evaluations per streamed line in `consoleMdPlan` | up to 6 | `public/core/console-markdown.js:372-391` |
| linear scans of the task list per row in `decorateTasks` | up to 4 (was 3) | `lib/assistant/queue.js:866-900` |
| turn line cap | 600 | `lib/jobs.js:73` |
| restart ledger cap | 20 | `lib/restart.js:57` |
| remotes cache TTL | 60 000 ms | `lib/base-ref.js:21` |
| fence fold threshold | 15 lines | `public/core/console-markdown.js:64` |

---

## Findings at a glance

Ranked by how much of a visible drag each could explain. Rank is explanatory power, not severity of the code
smell — E4 is the worst *shape* in the delta and the least likely to be felt.

| id | finding | cost class | where | rank |
|---|---|---|---|---|
| E1 | the raw console view re-joins and re-writes the whole turn's text for every arriving line | O(lines) per line → O(n²) per turn, plus a full re-layout per line | `public/app.js:9543` | 1 |
| E2 | `git remote` is spawned per row, with no in-flight dedupe and no cache on failure | one process spawn per row per scan | `lib/base-ref.js:31` via `lib/scheduler.js:511` | 2 |
| E3 | the drag's animation loop re-reads the scroller's box every frame and re-measures every queued card | forced layout per frame, O(rows) rect reads per frame at the edge | `public/assistant.js:2574`, `:2550` | 3 |
| E4 | `staleReason` adds a fourth linear scan of the task list per row, inside an already-quadratic `decorateTasks` | O(rows²), at most every 20 s | `lib/assistant/queue.js:352`, `:899` | 4 |
| E5 | `state.consoleRaw` and `state.consoleFocus` grow one entry per toggled turn and are never pruned | unbounded set, no cap | `public/app.js:63-64` | 5 |
| E6 | `consoleMdInline` runs 11 regex passes on every prose row of every repaint, including rows with no marker | per-row regex in the render loop | `public/core/console-markdown.js:102` | 6 |
| E7 | `drawRowText` re-parses the whole row whenever the arriving chunk contains a marker | O(line) per tick, bounded by line length | `public/app.js:7598` | 7 |
| E8 | a refused steer now costs an extra gateway `GET` before the refusal is answered | one extra round trip per refused steer | `lib/jobs.js:3370` | 8 |

---

## E1. The raw view re-renders the whole turn for every line that arrives

**Where.** `public/app.js:9543-9546`, in `drawJobLine` — the per-line SSE path.

```js
} else if (out.dataset.rawView === "1") {
  // The raw view is the turn's own bytes, so a line that lands while it is open is part of them: repaint the
  // text, never append a rendered row beside it.
  paintRawConsole(out);
}
```

**What it costs.** `paintRawConsole` (`public/app.js:7693-7702`) does three O(lines) things per call:

```js
function paintRawConsole(out) {
  if (out.dataset.rawView !== "1") out._mdHtml = out.innerHTML;
  out.dataset.rawView = "1";
  out._md = null;
  out.textContent = consoleMdRawText(consoleRawLines(out));
```

`consoleRawLines` filters the turn's whole line array (`public/app.js:7689-7692`), `consoleMdRawText` maps and
joins it (`public/core/console-markdown.js:438`), and `textContent =` replaces the console's entire text node —
which invalidates layout for the whole `<pre>`. So for a turn of *n* lines arriving one at a time, the raw view
does *n* full joins and *n* full text replacements: O(n²) string work and O(n) full re-layouts. With the
600-line cap (`lib/jobs.js:73`) the worst case is 180 000 line-joins and 600 full re-layouts of a 600-line
console, for one turn.

**Second path, same cost.** `paintStreamConsole` calls `wireConsole(out)` (`public/app.js:8177`), which calls
`paintConsoleModes` (`:7836`), which calls `paintRawConsole` when the reader's raw flag is on (`:7734`). So every
stream paint also builds the whole raw text — and then `syncStreamConsole` on the very next line replaces the
children with the rendered body, so the raw text is built and immediately thrown away. That is a render inside
a render, and it is wasted work even when the raw view is not what the reader is looking at.

**Smallest fix.** Append the one new line instead of re-joining the turn. `consoleMdRawText` joins with a single
`\n`, so appending `"\n" + text` produces byte-identical output:

```js
} else if (out.dataset.rawView === "1") {
  out.appendChild(document.createTextNode(`\n${String(line.text ?? "")}`));
}
```

That turns the per-line cost from O(lines) into O(1) and removes the full re-layout. The `paintStreamConsole`
path needs the same treatment or a guard: skip `paintConsoleModes`' raw repaint when `syncStreamConsole` is
about to replace the children anyway.

**Evidence class.** read (traced through both call paths; not measured).

---

## E2. `git remote` is spawned per row, deduped only by a cache that a failure never fills

**Where.** `lib/base-ref.js:31-43`, reached from `lib/scheduler.js:511` — once per row, per scan.

```js
async function remotesOf(projectPath) {
  const key = pathKey(projectPath);
  if (!key) return null;
  const hit = remotesCache.get(key);
  if (hit && Date.now() - hit.at < REMOTES_TTL_MS) return hit.remotes;
  const r = await gitIn(projectPath, ["remote"], 15000);
  // `null` means "could not look", which is not the same as "no remotes": an unreadable checkout must not turn a
  // correct configured name into a substitution, so the caller is told the question went unanswered.
  if (!r.ok) return null;
  const remotes = r.out ? r.out.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  remotesCache.set(key, { at: Date.now(), remotes });
  return remotes;
}
```

and the call site:

```js
// lib/scheduler.js:511
const row = await this.pool.run({ wtPath: rowPath, ctx: await this.ctxFor(project), depth });
```

**What it costs.** `gitIn` is `execFile("git", …)` (`lib/scan.js:24-30`) — a real process spawn. `ctxFor` is
called once per row, so this is a per-row shell-out, and it has two holes:

1. **A failed read is never cached.** `if (!r.ok) return null;` returns before `remotesCache.set`. A checkout
   where `git remote` fails — a locked index, a permissions problem, a path that is not a repo — therefore
   spawns `git` once per row on *every* scan, forever. On the fast tier that is a sustained spawn rate, not a
   one-off.
2. **No in-flight dedupe.** `fullPassProject` scans every row concurrently (`lib/scheduler.js:668-671`,
   `Promise.all(rows.map(...))`), and the cache is only written *after* the await. So on every cache miss all
   *n* rows miss together and all *n* spawn `git remote` at once — a thundering herd once per 60 s per project,
   on top of the failure case above.

The comment at `lib/base-ref.js:18-20` says "one answer per project per minute is plenty" — that is the intent,
and the code does not deliver it on either of the two paths that matter.

**Smallest fix.** Cache the failure and dedupe in flight. `chooseRemote` already treats `null` as "could not
look" and returns the configured name unchanged (`lib/base-ref.js:50`), so caching `null` preserves the
semantics exactly:

```js
const inflight = new Map();
async function remotesOf(projectPath) {
  const key = pathKey(projectPath);
  if (!key) return null;
  const hit = remotesCache.get(key);
  if (hit && Date.now() - hit.at < REMOTES_TTL_MS) return hit.remotes;
  if (inflight.has(key)) return inflight.get(key);
  const p = gitIn(projectPath, ["remote"], 15000)
    .then((r) => {
      const remotes = r.ok ? (r.out ? r.out.split("\n").map((l) => l.trim()).filter(Boolean) : []) : null;
      remotesCache.set(key, { at: Date.now(), remotes });
      return remotes;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
```

**Evidence class.** read. The spawn is certain (`gitIn` is `execFile`); the rate depends on the project's row
count and tier, which this review did not measure.

---

## E3. The drag's animation loop re-measures the scroller every frame

**Where.** `public/assistant.js:2568-2585` (`queueDragFrame`) and `:2550-2553` (`queueDragPaint`).

```js
function queueDragFrame() {
  const d = queueDrag;
  if (!d || !d.moved) { queueDragRaf = 0; return; }
  let dy = 0;
  const box = d.scroller?.getBoundingClientRect?.();
  ...
  if (dy && queueScrollBy(d, dy)) queueDragPaint(d, d.y);
  queueDragRaf = requestAnimationFrame(queueDragFrame);
}
```

```js
const cards = queueCardsIn(d.el).filter((c) => c !== d.el && c.dataset.asQstate === "queued");
const at = cards.find((c) => {
  const box = c.getBoundingClientRect();
  return clientY < box.top + box.height / 2;
});
```

**What it costs.** The loop re-arms unconditionally, so it runs at display rate for the whole gesture — not
only while the pointer is at an edge. Each frame reads `d.scroller.getBoundingClientRect()`, a forced layout,
even though the scroller's own box cannot change while it scrolls (only its `scrollTop` does). When the pointer
*is* at an edge, each frame also calls `queueDragPaint`, which runs `querySelectorAll(".as-task")` and then a
`getBoundingClientRect()` per queued card until the first midpoint match — O(rows) forced layouts per frame, on
top of the one already taken. At 60 fps with nine queued cards that is roughly 600 rect reads a second, all
during a gesture the reader is holding still.

This is not a leak: the loop is cancelled in `queueCardUp` (`:2640`), which is bound to both `pointerup` and
`pointercancel` (`:3460-3461`), and it self-terminates when `!d.moved` (`:2569-2571`). `queueDrag` is nulled
only in `queueCardUp`, so the loop cannot outlive the gesture. It is a per-frame cost, not a runaway.

**Smallest fix.** Measure the box once, at drag start, alongside the scroller it already measures
(`public/assistant.js:2606`), and stop the loop when there is nothing to do:

```js
// in queueCardDown, beside `scroller: queueScrollerOf(el)`:
box: queueScrollerOf(el)?.getBoundingClientRect() || null,
// in queueDragFrame:
const box = d.box;
...
if (!dy) { queueDragRaf = 0; return; }   // re-armed by the next pointermove
```

`queueDragScrollStart` is already called from `queueCardMove`, so re-arming on the next move is a one-line
change.

**Evidence class.** read.

---

## E4. `staleReason` adds a fourth linear scan per row to an already-quadratic `decorateTasks`

**Where.** `lib/assistant/queue.js:352` (the scan) and `:899` (the call).

```js
// lib/assistant/queue.js:352
const row = (Array.isArray(tasks) ? tasks : []).find((x) => Number(x?.id) === id);
```

```js
// lib/assistant/queue.js:899
const stale = staleReason(t, list);
if (stale) t.staleReason = stale;
```

**What it costs.** `decorateTasks` already scanned the list per row three times before this delta —
`running.find(...)` (`:868`), `running.filter(...)` for a queued row with files (`:881`), and
`holdState(..., { tasks: list })` (`:896`). `staleReason` makes it four. So the function is O(rows²) and the
delta makes it O(rows²) with a larger constant.

**How much drag it could explain: none.** `decorateTasks` runs from `queueView` (`lib/assistant.js:725`), which
the page reads at most once every 20 s per assistant (`public/assistant.js:2324`), and `queueDigest` calls it a
second time in the same view (`lib/assistant.js:736`). At nine rows that is 81 comparisons twice every 20
seconds. It is the worst *shape* in the delta and the least likely to be felt. It is filed because the brief
asked for O(rows²) to be named, not because it is the drag.

**Smallest fix.** Build the index once and pass it in:

```js
// in decorateTasks, before the loop:
const byId = new Map(list.map((t) => [Number(t.id), t]));
// in staleReason:
const row = tasks instanceof Map ? tasks.get(id) : (Array.isArray(tasks) ? tasks : []).find((x) => Number(x?.id) === id);
```

That removes the new scan without touching the three that were already there. Fixing those is a separate,
larger change and is not this delta's debt.

**Evidence class.** read.

---

## E5. `consoleRaw` and `consoleFocus` grow one entry per toggled turn and are never pruned

**Where.** `public/app.js:63-64`.

```js
consoleRaw: new Set(),
consoleFocus: new Set(),
```

**What it costs.** Both are keyed by turn id and written only in the two toggles (`:7752-7753`, `:7770-7771`).
Nothing removes an id when the turn leaves `state.jobs`, and nothing caps the set. A long session that toggles
raw or focus on many turns accumulates one short string per turn for the life of the page. The read side is
cheap — `paintConsoleModes` does two `Set.has` per console placement (`:7723`, `:7731`) — so this is a slow
memory leak, not a per-tick cost.

It is also not a new *class*: `state.consoleZoom` (`:59`) is a `Map` with exactly the same shape and the same
absence of pruning, and it predates this delta. The delta extends an existing pattern rather than inventing
one.

**Smallest fix.** Cap on add, in both toggles:

```js
if (state.consoleRaw.size > 200) state.consoleRaw.delete(state.consoleRaw.values().next().value);
```

or, better, delete the id where the turn is dropped from `state.jobs`. The cap is the one-liner; the prune is
the correct fix and needs the turn-removal site.

**Evidence class.** read.

---

## E6. `consoleMdInline` runs 11 regex passes on every prose row of every repaint

**Where.** `public/core/console-markdown.js:102-129`.

```js
function consoleMdInline(text) {
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  let s = cmEsc(text);
  s = s.replace(/`([^`\n]+)`/g, ...);
  s = s.replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, ...);
  s = s.replace(CM_URL_RE, ...);
  s = s.replace(/\*\*\*([^*\n]+?)\*\*\*/g, ...);
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, ...);
  s = s.replace(/(^|[^\w*])\*([^*\n]+?)\*(?![\w*])/g, ...);
  s = s.replace(/___([^_\n]+?)___/g, ...);
  s = s.replace(/__([^_\n]+?)__/g, ...);
  s = s.replace(/(^|[^\w_])_([^_]+?)_(?![\w_])/g, ...);
  return s.replace(/\u0000(\d+)\u0000/g, ...);
}
```

**What it costs.** Eleven passes over the line, one of them a global URL scan, for every prose row of every
repaint — including the overwhelming majority of rows that contain no marker at all. A 600-line turn repaint is
6 600 regex passes. It is bounded and it is the feature, but it is the "regex in a hot loop" the brief asked
about, and the common case pays for the rare one.

**Smallest fix.** One test before the passes:

```js
function consoleMdInline(text) {
  const raw = String(text ?? "");
  if (!/[*_`[]/.test(raw)) return cmEsc(raw);
  ...
}
```

A line with no marker cannot be changed by any of the ten passes, so the early return is exact, not an
approximation. It also makes the function agree with the guard `drawRowText` already uses
(`public/app.js:7616`).

**Evidence class.** read.

---

## E7. `drawRowText` re-parses the whole row whenever the arriving chunk contains a marker

**Where.** `public/app.js:7598-7602`.

```js
if (el.dataset && el.dataset.lkind === "text" && MD_MARK_RE.test(next.slice(String(el._drawn ?? "").length))) {
  el.innerHTML = consoleMdInline(next);
  el._drawn = next;
  return true;
}
```

**What it costs.** The test itself is cheap — `next.slice(drawn.length)` is the newly arrived chunk, so the
regex sees O(chunk), not O(line). The cost is what it triggers: `consoleMdInline(next)` re-parses the *whole*
line, and `innerHTML =` replaces the row's children. A line streamed in *k* chunks where each chunk carries a
marker is therefore O(k · len) — quadratic in line length. Bounded by the line, so it cannot explain a
console-wide drag, but it is the one place a streamed row is re-parsed rather than appended.

**Smallest fix.** Track whether the row currently has an open marker and only re-parse when the arriving chunk
could close one; otherwise fall through to the tail-append. The cheap version is to re-parse only when the
chunk contains a marker *and* the row's drawn text already contains an unpaired one. If that is more machinery
than it is worth, leave it: the guard is already the cheap path and the re-parse is bounded by the line.

**Evidence class.** read.

---

## E8. A refused steer now costs an extra gateway round trip

**Where.** `lib/jobs.js:3370`, in the non-OK branch of `steer()`.

```js
const probe = await this.runProbe(j);
const said = String(probe?.run?.status || "");
const why = classifyRefusal({ status: res.status, code: ..., runStatus: said, known: probe?.known, terminal: ... });
```

**What it costs.** One extra `GET /v1/runs/<id>` per refused steer, before the refusal is answered. That is a
deliberate trade — the status word is the only thing that tells the gateway's two 409s apart
(`public/core/steerable.js:68-79`) — and it is per refusal, not per row or per tick, so it cannot explain any
drag. It is filed because it is a network call added to a request path, which is one of the hunted patterns.

**Smallest fix.** Skip the probe when the gateway already named the refusal:

```js
const named = body?.error?.code || body?.code || null;
const probe = named ? null : await this.runProbe(j);
```

`classifyRefusal` already handles `known: undefined` and a null `runStatus`; a named code plus a 409 is enough
to classify `past_boundary` when the run is not reported parked, and the probe is only load-bearing for a
gateway that refuses without a code.

**Evidence class.** read.

---

## Where the delta is clean

These are the hunted patterns that came back empty, with the line that clears each. They are worth as much as
the list above.

**No interval, timeout or listener without a matching clear.** The delta adds no `setInterval`, no `setTimeout`
and no `addEventListener` to production code — a grep of every `+` line in the diff finds them only in `test/`
and `tools/` (a `sleep` helper, a watchdog, and the stub gateway's SSE keep-alive, which is cleared on
`req.on("close")`). The one new animation loop is `queueDragFrame` (`public/assistant.js:2568`), and it is
cancelled in `queueCardUp` (`:2640`) which is bound to both `pointerup` (`:3460`) and `pointercancel` (`:3461`),
and it self-terminates when the drag never moved (`:2569-2571`). `queueDrag` is assigned null in exactly one
place, so the loop cannot outlive the gesture. The three new console controls are branches inside the existing
document click handler (`public/app.js:16798-16818`), not new listeners.

**No `JSON.parse` in a hot loop.** All seven additions are in `test/` and `tools/` — reading a seeded ledger,
parsing a recorded request body, parsing a stub's body. No production path parses JSON per row or per tick.

**No per-row re-read of the job store.** `jobLines(id)` is a `Map.get` (`public/app.js:322-324`), so the raw
view's O(lines) cost is a filter over an in-memory array, not a store read. `queueContext()` builds the job and
row indexes once per `queueView` (`lib/assistant.js:694-710`), not per row. `lib/restart.js`'s `consumedEntry`
is a linear `find` over at most 20 entries (`MAX_CONSUMED`, `lib/restart.js:57`), called once per restart
request and once per execute — not a hot path.

**The tick's restructure is free.** `lib/assistant.js:2010-2022` moves `sweepQueues()` out of the sentry's
`try` into its own. That is a correctness fix (a throwing rule no longer skips the sweep) with no cost change:
the same one call per tick, now with its own catch.

**The new pure modules are O(1) or O(lines) with no hidden work.** `public/core/steerable.js` is a handful of
comparisons and one object allocation per call, and it is called once per job summary
(`lib/jobs.js:942`). `lib/base-ref.js`'s `chooseRemote` is O(remotes). `announced` (`lib/base-ref.js:26`) and
`remotesCache` (`:22`) are both bounded by the number of projects, not by rows or ticks.

**The signature term is the same order as its neighbours.** `conversationSignature`'s new `runSteerable`
(`public/app.js:9086`) is one `map` over the conversation's turns, exactly like the `runReattach` term beside
it. No new order of cost.

**Carried over, not introduced.** `condensedBodyHtml`'s `lines.indexOf(l)` (`public/app.js:2837`) is O(n²) over
a turn's lines, but it is the same expression the old inline `turnBody` map used — the delta moved it into a
named function without changing it. It is not this delta's debt, and it is not filed as a finding.

---

## What this review did not do

- **No measurement.** No server was booted, no browser was driven, no profile was taken. Every cost above is a
  mechanism traced through the code. The two findings that would benefit most from a measurement are E1 (a
  long turn with raw on, timed with and without) and E2 (a project whose `git remote` fails, counting spawns
  over a minute).
- **No judgement on which finding is the reader's drag.** The ranking is explanatory power from the code
  alone. If the drag is on a card whose raw view is off, E1 does not apply and E2 is the only candidate left.
- **No review of the pre-existing quadratic paths** in `decorateTasks` (`running.find`, `running.filter`,
  `holdState`) or in `condensedBodyHtml`. They are named where they interact with a finding and otherwise left
  alone.
- **No review of the test and tool files for cost.** They are harnesses; their `sleep` loops and stub timers
  are not production paths.
