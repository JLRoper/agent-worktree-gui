# The card told the reader a cwd the run never had

On the dogfood run the card said `.worktrees/commit-…-9791a7`, the agent's own `pwd` answered
`C:/Users/roper`, and the panel's boot line said `per-run cwd NO`. All three were true at once, and that is
the defect: the cwd line is drawn from the directory the panel **asked** the gateway for, and the panel never
knew whether the gateway **used** it. This doc records what the panel sends, what the installed gateway does
with it, whether the knobs patch still applies, and the smallest change to this repo that stops the card from
claiming a directory a run did not have.

## 1. What the panel sends, and where

| where | what |
|---|---|
| `lib/jobs.js:1899` | `j.cwd = cwd` — the directory the spawn resolved: a worktree the panel just cut, an existing one, or the project checkout |
| `lib/jobs.js:1979` | the run body: `{ input, session_id: thread, cwd }` — `cwd` goes on **every** run, unconditionally |
| `lib/jobs.js:1988` | the card's own console line, printed before the POST: `POST …/v1/runs · session … · cwd …` |
| `lib/jobs.js:1967` | the same path inside the prompt: `Work in … — run cd "<dir>" before your first terminal command` |
| `lib/jobs.js:857` | `summary()` hands `cwd` to the page |
| `public/app.js:3972-3990` | the card draws it: `<span class="cwd-label">cwd</span>`, tooltip `working directory: …` |

The prompt already carries the path because `lib/jobs.js:1965` says why, in as many words: *"supplying a run
body's cwd alone is not proof of the tools' actual directory"*. The panel has never trusted the field — but the
card did, and the card is what the reader reads.

## 2. What the installed gateway does with it

The gateway serving this box is **stock**: `C:\Users\roper\AppData\Local\hermes\hermes-agent`,
`code_version 0.22.5`, `code_sha bf0203a794`, pid 40260, listener `http://127.0.0.1:8642`
(`gateway_state.json`). Three independent reads, all taken on 2026-10-31:

**(a) capabilities.** `GET /v1/capabilities` answered 200 with **31 feature flags** and no `run_cwd`
(`max_turns` and `run_budget` are absent too). The panel says the same in words on every boot:
`logs/server.out.log:6986` — `18:30:01 agent transport ready: hermes ? · runs yes · steer yes · per-run cwd NO
(stock gateway — agents run in the gateway's directory)`, and the same line at `logs/server.out.log:4718`,
`:5492`, `:6002` and `logs/server-7330.out.log:6`. The panel's own live `/api/state` agrees right now:
`transport.capabilities.runCwd = false`, with **109 jobs holding a `cwd`** — every one of those cards draws a
`cwd` line the runs did not have.

**(b) source.** `grep -c cwd gateway/platforms/api_server_runs.py` → **0**. The runs handler never reads the
field; the run's `agent_kwargs` (`api_server_runs.py:824-827`) carries `ephemeral_system_prompt`,
`session_id`, `gateway_session_key`, `route`, `room_dispatch`, `room_execution_policy` and the model
overrides — no `cwd`. `grep -rn 'body.get("cwd")' gateway/platforms/*.py` finds nothing. An unknown body key
is not an error, so the POST succeeds and the field is dropped in silence.

**(c) a live canary, in the panel's own body shape.** Posted `{"input": …, "session_id": "cwd-canary-mvx48cd9",
"cwd": "C:/Users/roper/AppData/Local/Temp/wag/016ee9f0/canary-tree"}` to `POST /v1/runs`:

```
202 {"run_id": "run_258d7ad04b094b99a8657560016ab8ab", "status": "started", "replayed": false}
… 8s later, completed:
TOOL_PWD=/c/Users/roper
CONTEXT_CWD=C:\Users\roper
WANTED=C:/Users/roper/AppData/Local/Temp/wag/016ee9f0/canary-tree
```

Both halves are missing: the tool started in the gateway's directory and the prompt-side scope did too. The
**202** is the part that matters for the panel: there is no response the panel could read to learn the field
was ignored, so the capability probe is the only place this is knowable — which is exactly why the fix below
records it at spawn time instead of inferring it when the card is painted.

The reported card itself is no longer in the live store (109 jobs, none under `…-9791a7`); this doc
reproduces the mechanism, not that row.

## 3. Does `docs/hermes-runs-api-knobs.diff` still apply?

**Yes.** It is not stale — the two files it patches are byte-for-byte the ones it was taken from:

```
$ git -C …/hermes-agent hash-object gateway/platforms/api_server.py gateway/platforms/api_server_runs.py
f8160def3de65aa3a26d61196ca1e080e0d1c4f8     ← the diff's index line says f8160def3d
c7296d95cc01445479ce8b21e43c8ac716a662dd     ← the diff's index line says c7296d95cc

$ git -C …/hermes-agent apply --check <the committed blob of the diff>
(exit 0, silent)
```

Tested, not assumed. Two things cost a false negative on the way there, and both will bite the next reader:

- **Apply it from the blob, not from this repo's checkout.** This repo has `core.autocrlf=true`, so the
  checked-out `docs/hermes-runs-api-knobs.diff` is CRLF and `git apply` refuses it (`patch does not apply`,
  with a `?` printed at the end of every context line under `--verbose`). The committed blob is LF and applies
  cleanly: `git show HEAD:docs/hermes-runs-api-knobs.diff > "$LOCALAPPDATA/Temp/knobs.diff"` and then
  `git -C C:/Users/roper/AppData/Local/hermes/hermes-agent apply --check C:/Users/roper/AppData/Local/Temp/knobs.diff`.
- **It is not installed at the moment.** No `.orig-runs-api-knobs` backups sit beside the two files (the
  convention `docs/runs-api-phase1.md` says a re-apply leaves behind), and `run_cwd` appears nowhere in the
  installed tree except `hermes_cli/bang_shell.py`, an unrelated use. An update/repin replaced both files with
  upstream's, so the panel has been running against a stock gateway since — and `hermes update` will do it
  again the next time it runs.

So applying the patch is a real option, and the panel still has to be honest while it is *not* applied. That
is the split this proposal takes: the gateway keeps ignoring the field until somebody re-applies it, and the
card stops saying otherwise either way.

## 4. The proposal

Record one fact at the moment the run is accepted — **what the gateway did with the cwd** — and let the card
draw from that instead of from the request.

| `cwdApplied` | what it means | what the card says |
|---|---|---|
| `true` | the build that accepted this run advertised `run_cwd` | `cwd <tail>`, tooltip `working directory: <full path>` — the old rendering, now earned |
| `false` | that build dropped the field (no `run_cwd` in its capabilities) | `asked <tail>` + an amber `not applied` tag; tooltip: *asked for <path> · NOT applied: this gateway ignores a run body's cwd … the agent started in the gateway's own directory and was told to cd here* |
| `null` / absent | a record from before this flag existed, or a probe that never answered | `asked <tail>`, no tag; tooltip says the panel cannot tell either way |
| no `cwd` at all | an assistant turn, a revived session | `row <tail>` over `ownerPath` — a row is not a working directory, and the line used to call it `cwd` |

The flag is stamped from `Jobs.probe()`'s cached capabilities in `create()` (the probe is already called there
for `model_options` and is cached for 15s), carried by `summary()`, persisted with the job, and added to the
card's repaint signature. The line itself moves into one marked function so it can be tested the way
`branchCellHtml` and `aheadBehindCellHtml` are.

Three deliberate choices:

- **`false` is not `null`.** A stock gateway's answer is knowable and final; a record from before this change
  is not. Tagging an old card `not applied` would be a claim the panel cannot support — the same mistake in
  the other direction.
- **The asked path still shows.** The reader needs to know which tree the run was *sent* to (it is the tree
  the card is filed under), so the honest fix is the label and the tag, not a blank line. Hiding it would
  trade one silence for another.
- **The panel does not refuse to spawn on a stock gateway.** The prompt already tells the agent to `cd` in,
  and the work does land in the right tree; refusing would break the panel on the build most readers have.

### The diff (proposed, not applied)

```diff
diff --git a/public/app.js b/public/app.js
--- a/public/app.js
+++ b/public/app.js
@@ -3896,6 +3896,53 @@
   true,
 );
 
+// ---- cwd line: the directory the run was given, or only asked for
+// The line under a card's head used to read `cwd` over whatever path the panel had put in the run body,
+// and that is a claim the panel cannot always keep. A stock gateway drops a body's `cwd` without a word
+// (its `api_server_runs.py` mentions cwd zero times; measured 2026-10-31 — POST /v1/runs with
+// cwd=<tree> answered 202, and that run's own `pwd` said /c/Users/roper), so the agent started in the
+// gateway's directory and the card said otherwise. The line now says what the panel KNOWS:
+//
+//   cwdApplied true          the build that took this run advertised run_cwd, so the run was given it;
+//   cwdApplied false         that build ignored the field: the path is labelled `asked`, tagged
+//                            `not applied`, and the tooltip says where the agent actually started;
+//   null / undefined         a record from before this flag existed: `asked`, and no claim either way;
+//
+// and a card with no cwd at all falls back to the tree it is filed under, labelled `row` — never `cwd`,
+// because a row is not a working directory either.
+function cwdLineHtml(latest) {
+  const cwdAsked = normPath(latest.cwd);
+  const cwdRow = normPath(latest.ownerPath);
+  const applied = latest.cwdApplied;
+  const line = cwdAsked || cwdRow;
+  if (!line) return "";
+  const label = !cwdAsked ? "row" : applied === true ? "cwd" : "asked";
+  const title = [
+    cwdAsked && applied === true ? `working directory: ${cwdAsked}` : null,
+    cwdAsked && applied !== true ? `asked for: ${cwdAsked}` : null,
+    cwdAsked && applied === false
+      ? "NOT applied: this gateway ignores a run body's cwd (it does not advertise run_cwd — hermes-runs-api-knobs.diff is not applied), so the agent started in the gateway's own directory and was told to cd here"
+      : null,
+    cwdAsked && applied == null
+      ? "unknown: this record predates the gateway check, so the panel cannot say whether that gateway applied it"
+      : null,
+    cwdRow && cwdRow !== cwdAsked ? `worktree row: ${cwdRow}` : null,
+    latest.worktree ? `worktree: ${latest.worktree}` : null,
+  ].filter(Boolean).join("\n");
+  const rowChip = cwdAsked && cwdRow && cwdRow !== cwdAsked
+    ? `<span class="cwd-row mono" title="the worktree row this agent is filed under">row ${esc(tailPath(cwdRow, 2))}</span>`
+    : "";
+  const tag = cwdAsked && applied === false
+    ? `<span class="cwd-tag mono" title="the gateway did not apply this run\'s cwd">not applied</span>`
+    : "";
+  return `<div class="job-cwd" title="${esc(title)}">` +
+    `<span class="cwd-label">${label}</span>` +
+    `<span class="cwd-path mono">${esc(tailPath(line))}</span>` +
+    rowChip + tag +
+    `</div>`;
+}
+// ---- end cwd line
+
 function conversationHtml(conv) {
   const { thread, turns, latest } = conv;
   const collapsed = state.collapsedJobs.has(thread);
@@ -3965,27 +4012,9 @@
     // instead of leading the line.
     latest.runId ? `run ${String(latest.runId).replace(/^run_/, "").slice(0, 8)}` : null,
   ].filter(Boolean).join(" · ");
-  // Where this agent is actually working — the top of every card, one quiet line. A card is re-read to
-  // answer "which tree is this one in", and that fact used to appear only on a card whose session never
-  // got a title. Only the last segments are drawn; the full path, and the row this agent is filed under
-  // when that is a different folder, are in the tooltip.
-  const cwdHere = normPath(latest.cwd);
-  const cwdRow = normPath(latest.ownerPath);
-  const cwdLine = cwdHere || cwdRow;
-  const cwdTitle = [
-    cwdHere ? `working directory: ${cwdHere}` : null,
-    cwdRow && cwdRow !== cwdHere ? `worktree row: ${cwdRow}` : null,
-    latest.worktree ? `worktree: ${latest.worktree}` : null,
-  ].filter(Boolean).join("\n");
-  const cwdHtml = cwdLine
-    ? `<div class="job-cwd" title="${esc(cwdTitle)}">` +
-      `<span class="cwd-label">cwd</span>` +
-      `<span class="cwd-path mono">${esc(tailPath(cwdLine))}</span>` +
-      (cwdRow && cwdHere && cwdRow !== cwdHere
-        ? `<span class="cwd-row mono" title="the worktree row this agent is filed under">row ${esc(tailPath(cwdRow, 2))}</span>`
-        : "") +
-      "</div>"
-    : "";
+  // Where this agent is: one quiet line at the top of every card. What it may CLAIM is decided by
+  // `cwdLineHtml` from the job's own record — see the marker above that function.
+  const cwdHtml = cwdLineHtml(latest);
   // A run has no process to exit. The pool maps run status onto 0/1 so the old CLI card keeps
   // rendering, but printing "exit 0" for it reads as if a child process came and went — answer
   // "what happened" instead. A legacy CLI turn still has a real exit code worth showing.
@@ -7456,6 +7485,9 @@
     runReattach,
     l.runId || "",
     l.cwd || "",
+    // Whether the gateway applied that cwd: the card's line is drawn from it (`cwd` only when it was
+    // given, `asked` otherwise), so learning it late has to repaint the card.
+    `a${String(l.cwdApplied)}`,
     // The row this agent is filed under: the card's cwd line falls back to it, so a change must repaint.
     l.ownerPath || "",
     l.model || "",
diff --git a/lib/jobs.js b/lib/jobs.js
--- a/lib/jobs.js
+++ b/lib/jobs.js
@@ -683,6 +683,9 @@
             // Survives a restart like the ownership facts above: a turn that was refused a clarify call
             // is still that turn once the panel is back.
             clarifyUnavailable: Boolean(j.clarifyUnavailable),
+            // Whether the gateway took this run's cwd. A fact about the build that accepted the run, so it
+            // survives a restart: the card must not begin claiming a directory after a reload.
+            cwdApplied: j.cwdApplied ?? null,
             runId: j.runId || null,
             // The last event this panel printed. A re-attached card resumes from it instead of replaying the
             // run's whole transcript under the one the reader already has.
@@ -855,6 +858,10 @@
       // assistant's state; the card only needs to know that this turn hit it.
       clarifyUnavailable: Boolean(j.clarifyUnavailable),
       cwd: j.cwd || null,
+      // What the gateway did with that cwd: true when the build that accepted this run advertised
+      // run_cwd, false when it ignored the field (a stock gateway), null when it was never learned.
+      // The card draws `cwd` only on true — public/app.js, `cwdLineHtml`.
+      cwdApplied: j.cwdApplied ?? null,
       thread: j.thread,
       turn: j.turn,
       // True for the board assistant's own turns: the one card no rule may wake it about.
@@ -1981,6 +1988,13 @@
     if (modelOptions) body.model_options = modelOptions;
     if (opts.maxTurns) body.max_turns = Number(opts.maxTurns);
     if (opts.budget) body.run_budget = Number(opts.budget);
+    // What the gateway will DO with that `cwd`, learned BEFORE the POST because the POST cannot say: a
+    // stock gateway ignores a body field it does not know (no 400, no echo), so the capability probe is
+    // the only place this is knowable. Recorded on the turn rather than read at paint time, because the
+    // card has to describe the build that accepted the run, not whichever gateway is installed when the
+    // card is drawn — the reader is looking at a fact about the past.
+    const capTransport = await this.probe();
+    j.cwdApplied = capTransport.reachable ? capTransport.capabilities?.runCwd === true : null;
 
     // A line the spawner wants on the card, ahead of the request: a SPAWN IN name that had to be resolved to a
     // real tree is what this exists for, and the card is where the reader judges where that run went.
diff --git a/public/style.css b/public/style.css
--- a/public/style.css
+++ b/public/style.css
@@ -686,6 +686,10 @@
 .job-cwd .cwd-label { flex: none; letter-spacing: .04em; color: var(--dimmer); }
 .job-cwd .cwd-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--dim); }
 .job-cwd .cwd-row { flex: none; color: var(--dimmer); border: 1px solid #2b3240; border-radius: 4px; padding: 0 5px; }
+/* `not applied`: the path beside this tag is a directory the run was ASKED for, not the one it
+   started in — the amber is the same ink an approval and a running pill use, i.e. a thing the
+   reader may need to act on, not a decoration. */
+.job-cwd .cwd-tag { flex: none; color: #f0c674; border: 1px solid #4d3d12; background: var(--amber-bg); border-radius: 4px; padding: 0 5px; }
 .job-cwd:hover .cwd-path, .job-cwd:hover .cwd-row { color: var(--text); }
 .job.collapsed .job-cwd { margin-bottom: 3px; }
 /* Subagents a run delegated, under the card's head. The parent's own stream carries a single delegate_task call;
diff --git a/test/cwd-line.test.js b/test/cwd-line.test.js
new file mode 100644
--- /dev/null
+++ b/test/cwd-line.test.js
@@ -0,0 +1,73 @@
+// The card's cwd line may only call a directory the run's own when the gateway that accepted the run
+// advertised run_cwd. On a stock gateway the panel posts `cwd`, the gateway drops the field without a
+// word, and the agent starts in the gateway's own directory — the line said "cwd <tree>" anyway: the
+// dogfood card was drawn with .worktrees/commit-…-9791a7 while that run's own `pwd` answered
+// C:/Users/roper (probe run_258d7ad04b094b99a8657560016ab8ab, 2026-10-31).
+//
+// The function under test is READ OUT of public/app.js between its markers, not copied here: a change to
+// the page's own rule changes these answers.
+import assert from "node:assert/strict";
+import test from "node:test";
+import { readFileSync } from "node:fs";
+import vm from "node:vm";
+import { sliceRegion } from "../tools/panel-testkit.mjs";
+
+const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
+
+const context = vm.createContext({
+  window: {},
+  console,
+  document: { getElementById: () => null },
+  state: {},
+  // The page's own normaliser (public/app.js:512), passed in rather than sliced: it is one expression.
+  normPath: (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, ""),
+});
+// `esc` and `tailPath` are the shipped ones, out of the file the page loads first.
+vm.runInContext(read("public/core/dom-format.js"), context, { filename: "public/core/dom-format.js" });
+vm.runInContext(
+  sliceRegion(read("public/app.js"), "cwd line: the directory the run was given, or only asked for", "cwd line"),
+  context,
+  { filename: "public/app.js:cwd-line" },
+);
+const cwdLineHtml = context.cwdLineHtml;
+
+const TREE = "C:/repos/prooflib/.worktrees/proof-local-bbbbbb";
+const job = (over = {}) => ({ id: "j1", cwd: TREE, ownerPath: TREE, worktree: "proof-local-bbbbbb", ...over });
+const label = (html) => (/class="cwd-label">([^<]*)</.exec(html) || [])[1] || null;
+const title = (html) => (/<div class="job-cwd" title="([^"]*)"/.exec(html) || [])[1] || "";
+const tag = (html) => (/class="cwd-tag\b[^>]*>([^<]*)</.exec(html) || [])[1] || null;
+
+test("a run whose gateway took the cwd is drawn as its working directory", () => {
+  const html = cwdLineHtml(job({ cwdApplied: true }));
+  assert.equal(label(html), "cwd");
+  assert.match(title(html), /working directory: C:\/repos\/prooflib\/\.worktrees\/proof-local-bbbbbb/);
+  assert.equal(tag(html), null, "nothing to warn about: the run was given this directory");
+});
+
+test("a run whose gateway dropped the cwd says what it was asked for, and that it was not applied", () => {
+  const html = cwdLineHtml(job({ cwdApplied: false }));
+  assert.equal(label(html), "asked", "that directory may not be called the run's cwd");
+  assert.doesNotMatch(title(html), /working directory/, "and the tooltip may not call it one either");
+  assert.equal(tag(html), "not applied");
+  assert.match(title(html), /NOT applied: this gateway ignores/);
+  assert.match(title(html), /started in the gateway/);
+});
+
+test("a record from before the check claims nothing either way", () => {
+  const html = cwdLineHtml(job({}));
+  assert.equal(label(html), "asked");
+  assert.equal(tag(html), null, "'not applied' would be a claim this record cannot support");
+  assert.doesNotMatch(title(html), /working directory/);
+  assert.match(title(html), /unknown: this record predates the gateway check/);
+});
+
+test("a card with no cwd falls back to its row, and a row is not a working directory", () => {
+  const html = cwdLineHtml(job({ cwd: null }));
+  assert.equal(label(html), "row");
+  assert.match(title(html), /worktree row: C:\/repos\/prooflib/);
+  assert.doesNotMatch(title(html), /working directory/);
+});
+
+test("a card with neither draws no line at all", () => {
+  assert.equal(cwdLineHtml({ cwd: null, ownerPath: null }), "");
+});
```

## 5. How to prove it end to end

Measured on this branch (2026-10-31) in a throwaway export of `HEAD` — **not** in the worktree — so nothing
here depends on the panel being restarted:

```bash
cd C:/Users/roper/AppData/Local/Temp/wag/016ee9f0
rm -rf verify && mkdir verify
git -C C:/ProjectDevelopment/agent-worktree-gui/.worktrees/the-panel-tells-the-read-e06039 \
  -c core.autocrlf=false archive HEAD | tar -x -C verify
cd verify
sed -n '/^```diff$/,/^```$/p' docs/cwd-the-run-does-not-have.md | sed '1d;$d' > ../cwd-truth.patch
git apply ../cwd-truth.patch && echo APPLIED
node --check public/app.js && node --check lib/jobs.js
node --test test/cwd-line.test.js
```

What each step gives:

1. **RED first.** With the test file in place and the patch NOT applied, the test fails with
   `Error: missing region // ---- cwd line: the directory the run was given, or only asked for in source` —
   the harness reads the function out of `public/app.js`, so the test cannot pass against code that does not
   exist yet. (Measured: 1 test, 1 fail.)
2. **GREEN.** After `git apply`: `APPLIED`, both `node --check` silent, and
   `ℹ tests 5 · pass 5 · fail 0`.
3. **No regression.** `node --test --test-concurrency=4 test/*.test.js` on the patched export
   (re-run on the base this doc was rebased onto, `main` at `dfdf055` / 0.35.1):
   `ℹ tests 565 · pass 565 · fail 0` — exit 0 — and `node --test lib/jobs.test.js`:
   `RESULT: ALL PASS (59 checks)`. The extra `probe()` in `create()` is served by that file's fake gateway.
4. **Live, on the stock gateway this box runs.** Restart the panel and open a card: the line reads
   `asked …/commit-…` with the amber `not applied` tag, and hovering says where the agent actually started.
   The New-agent header's gateway chip already says the same thing (`gateway ignores per-run cwd`).
5. **If the knobs patch is ever applied**, the same test flips without a code change:
   `GET /v1/capabilities` starts advertising `run_cwd`, new cards read `cwd …` and carry no tag, and the
   canary from §2 comes back with `TOOL_PWD` equal to the directory that was asked for.

```bash
# the canary from §2, as a proof step (top-level await: --input-type=module): run it, then compare TOOL_PWD with the directory you passed
node --input-type=module -e '
const k=(await import("node:fs")).readFileSync(process.env.LOCALAPPDATA+"/hermes/.env","utf8").match(/^API_SERVER_KEY=(.+)$/m)[1].trim();
const body={input:"Run one terminal call: pwd . Reply with exactly TOOL_PWD=<its output> and nothing else.",session_id:"cwd-canary-"+Date.now(),cwd:"C:/Users/roper/AppData/Local/Temp/wag/016ee9f0/canary-tree"};
const r=await (await fetch("http://127.0.0.1:8642/v1/runs",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+k},body:JSON.stringify(body)})).json();
for(;;){await new Promise(r=>setTimeout(r,2000));const s=await (await fetch("http://127.0.0.1:8642/v1/runs/"+r.run_id,{headers:{Authorization:"Bearer "+k}})).json();if(!["started","running","queued"].includes(s.status)){console.log(s.status,s.output);break;}}'
```

## 6. What this does not fix

- **It does not make the gateway honour `cwd`.** That is `docs/hermes-runs-api-knobs.diff`, in another repo,
  wiped by every `hermes update`. §3 says it still applies; who re-applies it, and when, is a decision for the
  reader and not for a card.
- **It still does not MEASURE the run's directory.** `cwdApplied: true` means "the gateway that took this run
  advertised `run_cwd`, so it read the field", not "a probe watched its `pwd`". The panel has no channel that
  reports a run's own directory, and inventing one is a bigger change than this doc proposes.
- **Two sentences in the repo disagree about the patched gateway**, and this proposal touches neither.
  `lib/charter.js:47-49` and `public/app.js:13119` say the patch is *"accepted, and a run's tools still start
  in the gateway's directory — measured 2026-10-27"*; commit `065a3b0` says the opposite and carries the
  verification (*"context and pwd agree on the worktree"*). The first describes an earlier revision of the
  patch (before it set `agent.runtime_cwd`, the prompt-side half), and reads as if it were still true. It is
  worth settling separately — the chip's wording is the one place the panel speaks about the *patched* build.
- **The assistant's own cards are the same lie in a quieter place**: 64 of the 109 jobs on the live board
  (`/api/state`) are assistant turns, every one of them carrying `cwd = C:/Users/roper/.wag/state/assistant-cwd`
  — a directory none of those runs started in either. The diff above relabels them with everything else, but
  it does not give the assistant a directory it can actually work in; only the gateway patch does that.
