# Phase 0 — independent one-liners

Scope: the small, unrelated fixes that do not need a refactor and must not wait for one. Each is
a separate commit. Nothing in this phase touches the shape of `server.js`, `lib/jobs.js` or
`public/app.js`.

Status: in progress. Evidence is appended as each item lands; a checked box means the assertion
was run and its number read back.

---

## 0.1 — `npm test` harness (review #10, partial)

- [ ] `package.json` gains `"test": "node --test test/"`; no dependency is added.
- [ ] `test/helpers/server.mjs` boots the real `server.js` as a child process against a
      throwaway `PANEL_CONFIG` (free port, empty scan root, its own `logs/`), waits for
      `/api/health`, and tears it down. This is what lets route behaviour be asserted instead of
      inspected.
- [ ] `test/harness.test.js` asserts the project's own invariants: `type: module`, zero
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

- [ ] Each one returns `403 {error:"bad or missing x-panel-token"}` when `config.token` is set and
      the header is absent or wrong — the same sentence the other 41 use, so there is one rule.
- [ ] `/api/visible`'s "cheap and read-only, so it needs no token" comment goes: the route mutates
      scheduler state, and the rule is the rule.
- [ ] Assertion: `test/auth.test.js` boots a token-configured server and asserts 403 on all four
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

- [ ] `lib/open-url.js` owns the decision: `safeUrl(raw)` (parse + http(s) only returns the
      normalised string, else `null`) and `openerFor(url, platform)` (no shell, one argv element).
- [ ] Windows opens with `explorer.exe` — the URL is passed as a CreateProcess argument and never
      seen by a command interpreter. Fire-and-forget, because explorer's exit code means nothing.
- [ ] Assertion: `test/open-url.test.js` asserts no element of the win32 argv matches `cmd.exe`,
      that a URL containing `&` survives as exactly one argument, and that non-http(s) is refused.

## 0.4 — the engines floor that cannot start (review #1)

The review's premise was that `node:sqlite` fails *silently* on Node 18/20. In this tree it does
not get that far: five modules import it **statically** (`lib/subagents.js`, `lib/thinking.js`,
`lib/tool-calls.js`, `lib/tool-results.js`, `lib/session-usage.js`) and `server.js` imports one of
them, so on Node < 22.5 the module graph fails to link and the server exits before it can log
anything. The advertised floor is not a soft degradation, it is a boot failure.

- [ ] `package.json` `engines.node` → `>=22.5` (where `node:sqlite` landed).
- [ ] `README.md` (2 sites), `SETUP.md` (2 sites), `setup.cmd`, `setup.sh` → `22.5`, and the setup
      scripts compare major *and* minor instead of major alone.
- [ ] Assertion: `test/engines.test.js` reads every source file, finds the static `node:sqlite`
      imports, and asserts the advertised floor is `>=22.5`; plus the docs and setup scripts say
      the same number.

## 0.5 — the silent catches that hide the one error explaining a blank page (review #1, #4)

Two mechanisms, one symptom. When `/api/state` throws, the outer catch answers **400** with
`{error}` and logs nothing; `resync()` on the client never checks `r.ok`, so it feeds that error
object to `applySnapshot`, which paints an empty board. The page is blank and the only sentence
that explains it is discarded twice.

- [ ] `lib/errors.js`: `HttpError` (a status the handler chose) and `errorStatus(e)` (that status,
      else 500). 400 stops being the answer to "a bug".
- [ ] `server.js` outer catch: log every 5xx, answer `HttpError`'s status, and `res.destroy()`
      when `headersSent` — never `sendJson` into a socket that already has headers.
- [ ] `lib/activity.js`: the Hermes factories log once and return an empty value instead of
      resolving to `null` (which is what made `hermesSessionRoots` throw `for..of null`);
      `hermesSessionRoots` tolerates a null read.
- [ ] `lib/scheduler.js` `sessionRoots()`: log the failure instead of returning an empty `Map`
      in silence.
- [ ] `server.js` static serve: a read error that is not ENOENT/EISDIR is logged and answered 500,
      not disguised as `404 not found`.
- [ ] `public/app.js` `resync()`: `if (!r.ok) throw` with the server's message, so the banner says
      what happened instead of the board going empty.
- [ ] Assertion: `test/errors.test.js` for the mapping, `test/activity.test.js` for the
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
