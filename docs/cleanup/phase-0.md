# Phase 0 — independent one-liners

Scope: the small, unrelated fixes that do not need a refactor and must not wait for one. Each is
a separate commit. Nothing in this phase touches the shape of `server.js`, `lib/jobs.js` or
`public/app.js`.

Status: done. All five items landed; a checked box means the assertion was run and its number read
back. The numbers are in "Evidence read back" at the end.

---

## 0.1 — `npm test` harness (review #10, partial)

- [x] `package.json` gains `"test": "node --test test/*.test.js"` — scoped to this project's tests,
      so a nested worktree's copy is not discovered; no dependency is added.
- [x] `tools/panel-testkit.mjs` boots the real `server.js` as a child process against a
      throwaway `PANEL_CONFIG` (free port, empty scan root, its own `logs/`), waits for
      `/api/health`, and tears it down. This is what lets route behaviour be asserted instead of
      inspected.
- [x] `test/harness.test.js` asserts the project's own invariants: `type: module`, zero
      dependencies, a `test` script.

Assertion: `npm test` runs and the harness boots and stops a real server.

## 0.2 — auth on the four POSTs that skip it (review #3)

`server.js` had **45** POST routes; **41** called `authorised(req)`. The four that did not:

| route | line (before) | what it does unauthenticated |
|---|---:|---|
| `/api/refresh` | 1487 | runs a full fast scan pass |
| `/api/visible` | 1495 | rewrites the scheduler's visible-project set |
| `/api/fetch` | 1873 | starts a `git fetch` sweep over every project |
| `/api/reload` | 1883 | stops the scheduler and pool, re-reads config, rebuilds both |

- [x] Each one returns `403 {error:"bad or missing x-panel-token"}` when `config.token` is set and
      the header is absent or wrong — the same sentence the other 41 use, so there is one rule.
- [x] `/api/visible`'s "cheap and read-only, so it needs no token" comment goes: the route mutates
      scheduler state, and the rule is the rule.
- [x] Assertion: `test/auth.test.js` boots a token-configured server and asserts 403 on all four
      without the header, and not-403 on all four with it.

Known coupling (do not fix here): review #2 is still open — the client sends no
`x-panel-token` at all, so a token-configured panel is already unusable. Protecting these four
makes it fail closed like the rest; it does not make token mode work. That is Phase 1.

## 0.3 — `/api/open-url` must not hand the URL to `cmd.exe` (new: `C1`)

The route validated the URL and then ran `cmd.exe /c start "" <url>`. `execFile` avoids a shell,
but `cmd.exe` re-parses its own command line, so `&` in a query string is a command separator.
Node only quotes arguments that need it under Windows rules, and `&` does not need it — a URL
like `https://x/?a=1&calc.exe` is parsed by cmd as two commands. Validation cannot fix that: the
character is legal in a URL.

- [x] `lib/open-url.js` owns the decision: `safeUrl(raw)` (parse + http(s) only returns the
      normalised string, else `null`) and `openerFor(url, platform)` (no shell, one argv element).
- [x] Windows opens with `explorer.exe` — the URL is passed as a CreateProcess argument and never
      seen by a command interpreter. Fire-and-forget, because explorer's exit code means nothing.
- [x] Assertion: `test/open-url.test.js` asserts no element of the win32 argv matches `cmd.exe`,
      that a URL containing `&` survives as exactly one argument, and that non-http(s) is refused.

## 0.4 — the engines floor that cannot start (review #1)

The review's premise was that `node:sqlite` fails *silently* on Node 18/20. In this tree it does
not get that far: five modules import it **statically** (`lib/subagents.js`, `lib/thinking.js`,
`lib/tool-calls.js`, `lib/tool-results.js`, `lib/session-usage.js`) and `server.js` imports one of
them, so on Node < 22.5 the module graph fails to link and the server exits before it can log
anything. The advertised floor is not a soft degradation, it is a boot failure.

- [x] `package.json` `engines.node` → `>=22.5` (where `node:sqlite` landed).
- [x] `README.md` (2 sites), `SETUP.md` (2 sites), `setup.cmd`, `setup.sh` → `22.5`, and the setup
      scripts compare major *and* minor instead of major alone.
- [x] Assertion: `test/engines.test.js` reads every source file, finds the static `node:sqlite`
      imports, and asserts the advertised floor is `>=22.5`; plus the docs and setup scripts say
      the same number.

## 0.5 — the silent catches that hide the one error explaining a blank page (review #1, #4)

Two mechanisms, one symptom. When `/api/state` throws, the outer catch answers **400** with
`{error}` and logs nothing; `resync()` on the client never checks `r.ok`, so it feeds that error
object to `applySnapshot`, which paints an empty board. The page is blank and the only sentence
that explains it is discarded twice.

- [x] `lib/errors.js`: `HttpError` (a status the handler chose) and `errorStatus(e)` (that status,
      else 500). 400 stops being the answer to "a bug".
- [x] `server.js` outer catch: log every 5xx, answer `HttpError`'s status, and `res.destroy()`
      when `headersSent` — never `sendJson` into a socket that already has headers.
- [x] `lib/activity.js`: the Hermes factories log once and return an empty value instead of
      resolving to `null` (which is what made `hermesSessionRoots` throw `for..of null`);
      `hermesSessionRoots` tolerates a null read.
- [x] `lib/scheduler.js` `sessionRoots()`: log the failure instead of returning an empty `Map`
      in silence.
- [x] `server.js` static serve: a read error that is not ENOENT/EISDIR is logged and answered 500,
      not disguised as `404 not found`.
- [x] `public/app.js` `resync()`: `if (!r.ok) throw` with the server's message, so the banner says
      what happened instead of the board going empty.
- [x] Assertion: `test/errors.test.js` for the mapping, `test/activity.test.js` for the
      null-session crash, and the boot harness for the wiring (malformed body → 400, server still
      healthy afterwards).

---

## Verification for the whole phase

```
node --check server.js && node --check lib/*.js
npm test
curl -s localhost:<port>/api/health
curl -s localhost:<port>/api/state | <count projects>
```

plus one load of the page through the front door. The numbers are recorded below when read.

## Evidence read back (2026-10-24)

Phase 0's six fixes sit on top of `efdb451` (the phase index, the harness, auth, open-url, the
engines floor, then the error pass); the commits after them record this evidence, give the sandbox
its own discovery cache (the real checkout's `logs/projects.json` had been leaking 96 projects into
it, which reset `/api/reload` mid-sweep), and record the browser check below. `main` moved while the
phase was being finished, so the six were rebased onto `efdb451`, the suite was re-run there, and it
was run again in the main checkout after the fast-forward.

```
node --check server.js && node --check lib/*.js && node --check public/app.js
    -> no output: every file parses
npm test
    -> tests 19, pass 19, fail 0, cancelled 0, skipped 0, duration_ms 2888
       3 harness + 3 auth + 4 engines + 4 open-url + 4 errors + 1 activity
    -> the harness boots the real server: /api/health 200 {ok:true, projects:[]}
    -> the front door serves: GET / 200 with <script src="/app.js">
```

Two bullets in 0.1 name paths the implementation did not use; they now name what is on disk
(`node --test`, `tools/panel-testkit.mjs`), and the counts are the ones the suite printed.

### A running board and the blank-page fix, checked in a browser

A sandbox panel (`PANEL_CONFIG` on 18935) scanning a scratch root with one repo and one worktree:

```
GET /api/health   -> {"ok":true,"projects":["alpha"],...}
GET /api/state    -> projectCount: 1 (alpha), rows: 2
                     alpha | master    | ON MAIN   | dirty 0
                     beta  | wtgui/beta | NO COMMITS| dirty 0
page (Chromium)   -> "#stream-state": "● live"; header "1 project(s)";
                     folder "1 project 2 worktrees 1 dirty 2 live"; 2 tr.row nodes
```

The `resync()` line is the one change with no `npm test` assertion — it is browser behaviour, and
the suite stays dependency-free. It was checked end to end with Playwright (the global install,
not a repo dependency) by forcing `GET /api/state` to answer `500 {"error":"forced fault: state.db
is locked"}` and aborting `/api/stream`:

```
before (app.js reverted): banner text ""        hidden true
after                   : banner text "Cannot load the board: forced fault: state.db is locked"
                          hidden false
```

That is the difference the fix is for: the same failing server, and one of the two pages says why
it is empty.
