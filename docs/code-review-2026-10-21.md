# Code review — agent-worktree-gui — 2026-10-21

A structural and correctness review of the whole tree, written to be **acted on by the agent that owns
this repo**. The reviewer made no changes: no files edited, no server started, no git commands that
write. Every claim below was read out of the working tree or measured with a read-only command.

- Snapshot: `main` at **fff7a3c** ("Shift+Enter inserts a newline in the message boxes").
- At review time the working tree had one uncommitted edit in `public/app.js` (make "Collapse all"
  include the two fixed cards, via `FIXED_CARDS`).
- The rename-session work is committed as **ba676a0** ("Rename a session from its row"), so the
  `lib/jobs.js` / `server.js` halves of it are on disk and in scope here.
- Line numbers are from this snapshot. The file is being edited continuously; treat a number that is
  off by a few lines as still pointing at the named function.

---

## For the receiving agent — read this first

1. **This is a recommendation, not a work order.** The user asked for "where it's disorganized or
   could be broken into better modules — just recommend". Nothing here is approved for
   implementation. Ask before starting a multi-file refactor.
2. **Two invariants must survive any refactor:**
   - **Zero dependencies, no build step.** No npm install, no bundler, no transpiler. Native ES modules
     served straight from `public/` are the only acceptable client-side mechanism.
   - **The comments carry the reasoning.** Most non-obvious code here explains a measured cause
     ("the inline-block baseline leaves ~5px", "a pinned block can change the page height again on the
     next layout pass"). Move comments *with* the code they explain; do not summarise them away.
3. **Do the correctness items (1–9) before the structural ones (A–G).** They are small, they are
   independent, and two of them are hidden breakage rather than style.
4. **Do not begin B/C while you are mid-feature in `server.js` or `lib/jobs.js`.** Those are the two
   files a route-table or job-split touches most, and a refactor interleaved with a feature produces a
   diff neither you nor the user can review.
5. After each step, verify with what this project already trusts: `node --check` on every touched file,
   `curl` to `/api/health`, a project count from `/api/state`, and a browser check through the front
   door rather than only the API.

---

## Verdict

The server side is already modular and unusually well reasoned: `lib/` separates state (`store`),
cadence (`scheduler`), execution (`pool` + `scan-worker`), evidence (`activity`), discovery
(`projects`), spawning (`jobs`) and the approval transport. That is the right shape and should be kept.

The disorder is concentrated in three places:

- `public/app.js` — **3,389 of the ~7,500 lines**, one global `state` object, one non-module script.
  It contains the entire UI: formatting, localStorage persistence, five rendering layers, SSE wiring,
  a 28-branch delegated click handler, zoom and fonts.
- `server.js` — 659 lines that are simultaneously a composition root, an HTTP framework and domain
  glue, with 22 inline route checks and auth applied by hand on 12 of 14 POSTs.
- `lib/jobs.js` (622) and `lib/activity.js` (341) — each has quietly become four or five modules in a
  trench coat: a CLI contract, a stream protocol, a job registry and a label store in one; five
  unrelated system probes in the other.

Below the structural issues are two real defects and a handful of latent ones. The most consequential
is #1: on the Node version this project publicly requires, every Hermes-session signal silently
disappears, and nothing logs it.

---

## Findings by risk

Severity is about consequence, not effort.

| # | Finding | Severity | Effort | Area |
|---|---------|----------|--------|------|
| 1 | `engines: >=18` but `node:sqlite` needs >=22.5; failure is silent | **High** | S | `lib/activity.js`, `package.json`, README, SETUP |
| 2 | Documented `token` setting is unusable from the UI (client never sends the header) | **High** | S | `server.js`, `public/app.js`, README |
| 3 | Auth is opt-in per route; 3 POSTs skipped it | Medium | S | `server.js` |
| 4 | One outer `catch` answers 400 for internal faults; can double-write after headers | Medium | S | `server.js` |
| 5 | `conversationSignature` is a hand-maintained field list (drift already shipped once) | Medium | M | `public/app.js` |
| 6 | Path normalisation: 20 copies, two incompatible rules | Medium | S | 8 files |
| 7 | Composition-root TDZ ordering (`normPathKey`, `jobs` used above their declarations) | Low | XS | `server.js` |
| 8 | Static-file boundary is a bare string prefix | Low | XS | `server.js` |
| 9 | Dead code: `jobHtml`, `isAgentRunning` | Low | XS | `public/app.js` |
| 10 | No test runner; pure logic is untested | Medium | M | repo-wide |

---

### 1. `engines >= 18` vs `node:sqlite` (>= 22.5) — silent loss of every Hermes signal

`lib/activity.js:116` (`hermesSessions`) and `lib/activity.js:171` (`hermesTouchedPaths`) both do:

```js
const { DatabaseSync } = await import("node:sqlite");
```

`node:sqlite` landed in Node **22.5.0**. The project advertises Node 18 in three places:
`package.json:13` (`"node": ">=18"`), `README.md:6` and `README.md:27`, `SETUP.md:4` and `SETUP.md:28`.

On Node 18/20 the failure is completely silent, which is what makes it dangerous:

1. the dynamic import rejects;
2. `memo` (`lib/activity.js:30`) catches it and resolves to the previous value — `null` on first call;
3. `hermesSessionRoots` (`lib/activity.js:206`) then does `for (const s of sessions)` on `null` and throws;
4. `Scheduler.sessionRoots` (`lib/scheduler.js:200`) catches it, returns an empty `Map`, and logs nothing.

Net effect: no ⧉ chips, no "live" from a Hermes session, no session→worktree attribution — the exact
mechanism the ownership model and the row ordering rest on — with no error anywhere to explain it.

Fix: either require `>=22.5` in all four places, or feature-detect once at boot and log a single loud
warning ("node:sqlite unavailable — Hermes session detection disabled"), and stop swallowing the
scheduler's catch (`lib/scheduler.js:207`) without a log line.

---

### 2. The `token` setting cannot work from the browser

`server.js:280` (`authorised`) compares `req.headers["x-panel-token"]` to `config.token`, and
`README.md:231` documents `token` as "if set, write endpoints require an `x-panel-token` header".
`public/app.js` contains **zero** occurrences of `x-panel-token`: none of its 13 `fetch` calls send it.

So setting `token` turns the panel into a read-only board that fails every action with a 403 —
indistinguishable from a broken app. Either add the header in one client-side fetch wrapper (see A/`api.js`)
or remove the feature claim. Do not leave it as-is.

---

### 3. Auth is opt-in, and three POSTs are unprotected

14 POST routes; 12 call `authorised(req)`. Missing:

- `/api/refresh` (`server.js:521`)
- `/api/fetch` (`server.js:584`)
- `/api/reload` (`server.js:590`)

None of them spawns a process or writes a file, so this is not remote code execution — but a server
that **can** spawn agents should not depend on each new route remembering a line. All GETs are also
unauthenticated, which is defensible on loopback; the problem is that the decision is made by omission
per route rather than once.

Fix: the route table in B, with `auth` defaulting to `true`.

---

### 4. One outer `catch` answers 400 for everything, and can double-write

`server.js:625`:

```js
} catch (e) {
  sendJson(res, 400, { error: String((e && e.message) || e) });
}
```

Two problems:

- **Wrong status.** A bug in a handler reports as a client error, so it is invisible to logs and to any
  future monitor. Internal faults should be 500 and logged.
- **Double write.** If a handler throws after `writeHead`/`sendJson` (a static file half-written, an SSE
  client that died mid-`res.write`), `sendJson` throws `ERR_HTTP_HEADERS_SENT` *inside the catch*, and
  the async request handler rejects. On current Node that is an unhandled rejection, i.e. a possible
  process exit from a routine client disconnect.

Fix: a small `HttpError` carrying a status; `catch` maps that to its status, everything else to 500 +
`log`; guard with `if (res.headersSent) return res.destroy()`.

---

### 5. `conversationSignature` is a hand-maintained field list, and it already drifted

`public/app.js:1239` builds a ~17-field string to decide whether a card must be repainted. Every new
piece of card state has to be appended or the card silently stops updating. This is not hypothetical:
the rename feature had to add `l.label` to it, and the same class of bug is waiting for the next field
(approval count, pin state of a *new* kind, a draft marker, …).

Related state-restoration machinery exists only because cards are rebuilt with `innerHTML`:
`captureTyping`/`restoreTyping` (`public/app.js:762`/`768`) and `captureScrolls`/`restoreScrolls`
(`public/app.js:1105`). Three places to touch for every new control is the growth hazard in this file,
not its line count.

Two fixes, increasing cost:

- **(a) cheap:** one `html` tagged template that escapes every interpolation by default (opt out with
  `raw()`), so string building is safe by construction and one helper replaces ~30 hand-written `esc(...)`
  sites. No escaping hole was found in the current code — this is prevention, not a patch.
- **(b) correct:** `paintCard(thread, viewModel)` that diffs a view model instead of re-serialising
  HTML. State lives in one object; no field list to forget. The agent cards are the hot path (they
  stream), so this is where it pays.

---

### 6. Path normalisation: 20 occurrences, two incompatible rules

`replace(/\\/g, "/").replace(/\/+$/, "")` appears **20 times across 8 files**, some of them lowercasing
and some not:

- lowercasing: `lib/activity.js:52`, `lib/pool.js:16`, `lib/scheduler.js:21` and `:460`,
  `server.js:200` (`normPathKey`), `server.js:479-480`, `public/app.js:1472`
- case-preserving: `lib/hermes-worktrees.js:25`, `lib/projects.js:15`, `lib/jobs.js:390/457/531/581/596`,
  `server.js:552`, `public/app.js:252`

On a case-insensitive Windows filesystem, mixing the two is a latent mismatch class: an `ownerPath`
stored case-preserving compared against a row key that was lowercased elsewhere. It works today because
the call sites happen to pair consistently — that is luck, not design.

Fix: one `lib/paths.js` exporting `display(p)` (forward slashes, trailing slash stripped, case kept) and
`key(p)` (the same, lowercased, for comparison). Serve the identical file to the browser from
`public/shared/paths.js` and `import` it from Node — one source of truth, still no build step.

---

### 7. Composition-root ordering hazard

`server.js:163` (`adoptFromJob`) and the `panelAgents` closure at `server.js:138` reference
`normPathKey` (declared at `:200`) and `jobs` (declared at `:172`) before their `const` declarations.
It is safe only because neither runs synchronously during construction. Any future emit from the `Jobs`
constructor, or a `scheduler.start()` that calls back earlier, becomes a `ReferenceError` at boot.

Fix: declare helpers, then instances, then wire callbacks — the standard three-block composition root.

---

### 8. Static-file boundary is a bare string prefix

`server.js:606`: `if (!filePath.startsWith(PUBLIC_DIR))`. `path.join` already normalises `..`, so
traversal is blocked — but a sibling directory whose name begins with `public` would pass, and the
comparison is case-sensitive on a case-insensitive filesystem.

Fix: `filePath === PUBLIC_DIR || filePath.startsWith(PUBLIC_DIR + path.sep)`.

---

### 9. Dead code

`public/app.js:936` `jobHtml` and `public/app.js:1622` `isAgentRunning` are defined and never
referenced (verified by whole-tree search, not by inspection).

---

### 10. No tests, and the testable logic is not exported

There is no `npm test`. `tools/verify-verdicts.mjs` is a genuine independent check of merge verdicts
against git — keep it — but everything else is verified by ad-hoc probes in a scratch directory that no
one else can rerun.

The parts worth real tests are pure and small:

- `lib/jobs.js` `parseLine` (145) and the paragraph-merging `push` (327) — the trickiest logic in the repo;
- `lib/store.js` `putRow` fast-merge rules (80) — EMPTY REPO / ON MAIN / "unchanged count keeps the last verdict";
- `lib/activity.js` `deepest` (210) and `pathsIn` (159) — attribution correctness;
- `lib/jobs.js` `setLabel` sanitising (317);
- the client's ordering (`orderRows`) and signature function.

`node:test` is built in and zero-dependency, which fits this project's constraint exactly. Export the
pure functions and test them; do not add a framework.

---

## Structural recommendations

### A. `public/app.js` (3,389 lines) → native ES modules

One script tag (`public/index.html:` last line, `<script src="/app.js">`) and one mutable `state`
object. The section comments already mark the seams. Proposed split — move code, change nothing:

| New module | Lines now | Contains |
|---|---|---|
| `js/state.js` | 5–41 | the single `state` object |
| `js/format.js` | 45–110 | `esc`, `relTime`, `fmtDur`, `elapsed`, `verdictClass` |
| `js/paths.js` | 252–275, 1472 | `normPath`, `rootOf`, `keyOf` (or the shared `paths.js` from #6) |
| `js/storage.js` | 120–250 | the five load/save localStorage pairs → one generic `loadSet/saveSet` |
| `js/api.js` | 13 `fetch` sites | `postJson()`, `post()`, `resync()` — headers, `r.ok`, error banner in one place |
| `js/html.js` | new | the escaping `html` template from #5(a) |
| `js/render/agents.js` | 470–1040 | conversation, turns, cards, rename, attach, clear |
| `js/render/approvals.js` | 1041–1104 | approval cards |
| `js/render/rows.js` | 1496–2014 | `rowHtml`, `detailHtml`, age cell, ring, chips |
| `js/render/projects.js` | 2015–2393 | ordering, reorder, root/project sections, `placeRow` |
| `js/render/snapshot.js` | 1149–1495, 2394–2548 | `renderJobs`, `updateJob`, `renderAll`, `applySnapshot` |
| `js/events.js` | 2705–3194 | delegated click/keydown/input handlers |
| `js/settings.js` | 3195–3389 | zoom + fonts |
| `js/main.js` | boot | `connect()`, initial fetch |

Notes: `<script type="module" src="/js/main.js">`; no bundler; keep the `// ---- name ----` comments as
the header of each module. Do the leaves first (`format`, `paths`, `storage`, `api`) in commits that
only move code, then the render layers, then `events.js` last.

### B. `server.js` (659 lines) → route table + http + live

Currently one `createServer` callback with **22 inline route checks** (285–630), each repeating
auth + `readBody` + validate. Also in the file: config boot, `broadcast`, `handleStream`,
`withLiveAgents`, `snapshot`, `adoptFromJob`, static serving, shutdown.

- `lib/http.js` — `sendJson` (gzip), `readBody`, `staticFile`, `HttpError`.
- `lib/live.js` — `clients`, `broadcast`, `handleStream`, `snapshot`, `withLiveAgents`.
- `lib/routes/agents.js`, `jobs.js`, `state.js`, `repos.js`, `approvals.js` — each exports an array of
  `{ method, path, auth = true, body, handler }`.
- `server.js` — imports, construct, wire, listen; ~80 lines.

This directly removes findings #3 and #4 and makes the auth decision explicit at every route.

### C. `lib/jobs.js` (622 lines) → three modules

Four concerns are stacked:

- **Hermes CLI contract** (57–140): `childEnv`, `openRouterKey`, `keyStatus`, `makeThreadName`,
  `buildArgv`, `resolveBinary`, `keyCacheHint`. Pure-ish, testable, no state.
- **Stream protocol** (142–172, 327–353): ANSI stripping, `parseLine`, and the paragraph-merging `push`
  — the single most intricate function in the repo, currently untestable because it lives on the class.
- **Job lifecycle** (355–520): `create`, `watchNewWorktree`, watchdog timer, `cancel`.
- **Persistence + labels** (192–326): `load`, `schedulePersist`, `loadLabels`, `saveLabels`, `setLabel`.

Split into `lib/hermes-cli.js`, `lib/job-stream.js` (pure functions taking and returning lines),
`lib/job-store.js`, with `lib/jobs.js` left as the runner. `push` and `create` both shrink; the stream
logic becomes unit-testable (#10).

### D. `lib/activity.js` (341 lines) → probes

Five unrelated readers with five different TTLs and failure modes: netstat ports (55), tasklist pids
(69), board JSON (79), Hermes `state.db` ×2 (116, 171), `.env` ports (254), then attribution (206) and
the composite (272). Its only current cohesion is "reads the outside world".

Split: `probes/{ports,pids,board,memo}.js`, `hermes/sessions.js` (both sqlite reads + `pathsIn` +
attribution), `signals.js` (composite). Keep `memo` — the single-flight promise sharing is good code and
should not be lost in the move.

### E. Verdict policy out of the store

Verdict rules are spread over three files: full classification in `lib/scan.js:43`, fast-path merge
rules in `lib/store.js:80` (`putRow` decides EMPTY REPO / ON MAIN / reuse-last-full-verdict), and
staleness tiers in `lib/scheduler.js:218` (`intervalFor`). A "store" that owns classification policy is
not a store; it is where the next verdict bug will hide.

Extract `lib/verdict.js` with those rules as pure functions. `tools/verify-verdicts.mjs` then validates
one module instead of the whole system, and every one of those rules becomes testable.

### F. The 28-branch delegated click handler → handler table

`public/app.js:2705` to ~`3024`: one listener, **28** `e.target.closest(...)` branches, each act-and-return.
Ordering is semantic (controls before the head-fold guard), so the chain grows by one branch per control
and the ordering rule lives only in the reader's head.

Fix: a `Map`/array of `{ selector, handler, preventDefault }` walked once per click, with the fold guard
declared last. "Nothing inside a clickable head may fall through to the accordion" is already an explicit
rule in this project — it deserves to be data, not branch order.

### G. A written client/server contract

Duplicated vocabulary with no enforcement: status words (`running`/`not-running`), the job summary shape
(`lib/jobs.js:241` vs every field `app.js` reads), thread naming, and homelessness (`ownerPath` on the
server vs `isHomelessConv` on the client). Nothing enforces agreement.

Cheap version: one `lib/contract.js` with JSDoc `@typedef`s for `Job`, `Row`, `Project`, `Snapshot`,
imported (type-only) by both sides. Optional later step: `tsc --checkJs --noEmit`, still no runtime
dependency.

---

## Target layout

```
server.js                     composition root only (~80 lines)
lib/
  http.js                     sendJson/gzip, readBody, staticFile, HttpError
  live.js                     SSE clients, broadcast, stream, snapshot, withLiveAgents
  paths.js                    display() / key()
  contract.js                 JSDoc typedefs shared with the client
  routes/{state,agents,jobs,repos,approvals}.js
  verdict.js                  all classification rules (out of store/scan/scheduler)
  jobs.js                     runner only
  hermes-cli.js               argv/env/binary contract
  job-stream.js               ANSI, parseLine, merge (pure)
  job-store.js                persistence + labels
  probes/{memo,ports,pids,board}.js
  hermes/sessions.js          state.db reads + attribution
  signals.js                  the composite
  (unchanged: store, scheduler, pool, scan, scan-worker, projects, project, approvals, hermes-worktrees)
public/
  index.html                  <script type="module" src="/js/main.js">
  shared/paths.js             same file Node imports
  js/{state,format,storage,api,html,events,settings,main}.js
  js/render/{agents,approvals,rows,projects,snapshot}.js
  style.css                   unchanged
tools/verify-verdicts.mjs     unchanged
test/*.test.js                node:test
```

---

## Work order

**Phase 1 — correctness, small, independent (safe to start now):**

1. `engines` + README + SETUP to `>=22.5`, or feature-detect `node:sqlite` and log once; log the
   scheduler's swallowed attribution error (#1).
2. `lib/paths.js` + the shared browser copy; migrate the 20 call sites (#6).
3. Client fetch wrapper that sends `x-panel-token` (fixes #2; becomes `js/api.js` in A).
4. Delete `jobHtml`, `isAgentRunning` (#9); fix the static boundary (#8); reorder the composition root (#7).
5. `node:test` with tests for `parseLine`/`push`, `putRow`, `pathsIn`/`deepest`, `setLabel` (#10).

**Phase 2 — server structure (after the current UI feature lands):**

6. `HttpError` + 500 default + `headersSent` guard (#4).
7. Route table: `lib/http.js`, `lib/live.js`, `lib/routes/*` (B) — this is where #3 is fixed by design.

**Phase 3 — client structure:**

8. `app.js` → modules, leaf-first, move-only commits (A).
9. Escaping `html` template, then `paintCard` view models for agent cards (#5).

**Phase 4 — the remaining libs:**

10. `jobs.js` → three modules (C); `activity.js` → probes (D).
11. `verdict.js` out of store/scan/scheduler (E).
12. Click-handler table (F) — last, because it needs a judgement per branch.

---

## Do not "fix" these

- `public/style.css` (689 lines) — sectioned by feature, and cascade order is load-bearing. Splitting it
  buys nothing and risks the specificity fixes that are already documented inline (`tr.detail .live-block ul`).
- `lib/pool.js`, `lib/approvals.js`, `lib/project.js`, `lib/scan-worker.js` — small, single-purpose, correct.
- The performance work: single-flight `memo`, gzip on text, the signature-guarded re-render, the SSE
  panel-agent overlay, the tiered scan cadence. These were measured into existence; a "cleaner" rewrite
  will silently re-introduce the 100-process `tasklist` storm or the periodic re-render hitch.

---

## Measurements and method

Read-only: `git status`/`log`/`diff`, `wc -l`, `grep`, `node --check` on all 14 JS files (all pass),
and three small Python reads for counting and line-anchoring. No server start, no writes, no probes
against the running panel.

- 3,389 `public/app.js`; 659 `server.js`; 622 `lib/jobs.js`; 496 `lib/scheduler.js`; 341 `lib/activity.js`;
  307 `lib/projects.js`; 266 `lib/scan.js`; 172 `lib/store.js`; 131 `lib/pool.js`; 105 `lib/project.js`;
  99 `lib/hermes-worktrees.js`; 87 `lib/approvals.js`; 689 `public/style.css`; 129 `public/index.html`.
- 22 route checks in `createServer`; 14 POSTs, 12 with `authorised()`.
- 28 `closest()` branches in the delegated click handler.
- 23 `innerHTML` assignments; 13 `fetch` calls; 44 `addEventListener` calls.
- 53 `catch` blocks in `server.js` + `lib/`, 13 of them empty or comment-only fallbacks.
- 20 path-normalisation expressions across 8 files; 0 occurrences of `x-panel-token` in the client.
