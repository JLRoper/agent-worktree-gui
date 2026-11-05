# Restarting the Matrix bridge and proving both directions — 2026-11-05

The bridge was stopped and started through the panel's own routes, and the run was witnessed at every step from
the log, the pid file and the process table. Outbound is proven twice over: the startup ping, and an outbox card
delivered exactly once. **Inbound is not proven** — the machine holds no second Matrix account, and the bridge
drops every event whose sender is its own user id, so the reader has to send the one message (see §7).

Status: measured 2026-11-05 between 02:09 and 03:17 local on `wtgui/restart-the-matrix-bridg-b15405` (1.12.1).
No product code changed; the only source edit this run makes is the runbook caveat in §7 of
`matrix-bridge/README.md`.

## 1. What was running when the work started

The brief described a hung instance — pid 66916 with child 13956, a log frozen at 09:01:50 and an undelivered
499-char card in `outbox.txt`. **None of that was live at 02:09**: no process carried those pids, the log's last
write was 02:02:40, and `outbox.txt` did not exist. What the panel and the OS actually reported:

```
GET /api/settings/matrix
  running  true
  pid      5688
  stalePid null
  roomId   !MhEkAdgpCRtqFDHyxy0O4wY1QAsTo5U0s8WyKV1IhyY
  pidFile  <panel state dir>\matrix-bridge.pid
```

The live tree was:

```
5688  (parent 9880, the panel)   .venv/Scripts/python.exe hermes_matrix_bridge.py
33476 (parent 5688)              the same command line — the venv's python launcher
```

The 499-char card was not undelivered either: it had gone out at `[19:56:12]` as
`$SjrYrBZq4rC6AdkWCsFY0lhpKVBCtBFGNWFaPZDtFw4, 499 chars`, `outbox.txt` had been renamed to `outbox.sent`, and
the previous instance had answered an inbound message at `[01:29:50] <- Bert Jeremiah: …`. The brief's snapshot
predated all of that. The restart went ahead anyway — the panel's recorded instance was four hours old, and a
clean stop/start is the only way to prove the current one.

## 2. Stop — the panel's route, not a bare kill

`POST /api/settings/matrix` is a settings write only; the stop action is its own route. It answers 200 and kills
the process **tree**, so the venv launcher goes with the interpreter:

```
POST /api/settings/matrix/stop   -> 200
{"running": false, "pid": null, "stalePid": null, "stopped": true,
 "note": "stopped pid 5688 (taskkill /T /F)"}
```

The panel's own log agrees:

```
07:10:06 matrix bridge stopped (pid 5688) via taskkill /T /F
```

Checked after the kill, not assumed:

- no process on the machine has `hermes_matrix_bridge` in its command line (the only matches were the checking
  commands themselves);
- the panel's pid file (`matrix-bridge.pid` under `.wag/state`) is gone;
- `GET /api/settings/matrix` says `running: false, pid: null, stalePid: null`.

One stale record did survive outside the panel: the **legacy helper** pid file `~/.hermes-matrix-store2/bridge.pid`
held `33476` — the dead launcher. `restart_bridge.py` and `verify_restart.py` read that file and `taskkill` what it
names, so a recycled pid there is a kill aimed at an unrelated process. It was moved to
`%TEMP%\wag\0272b951\legacy-store2-bridge.pid.bak`. The bridge's authoritative lock
(`MATRIX_STORE_DIR/bridge.pid`) was already absent.

## 3. Start — through the panel, new pid matched three ways

```
POST /api/settings/matrix/start  -> 200
{"running": true, "pid": 29468, "stalePid": null, "started": true, "error": null}
```

```
07:10:35 matrix bridge started (pid 29468): <bridge venv python> hermes_matrix_bridge.py
```

- the pid file the panel wrote: `{"pid": 29468, "startedAt": "2026-11-05T07:10:35.193Z", …}` — **29468**, the
  panel's number;
- the process table: `29468` (parent `9880`, the panel) with **exactly one** python child, `37688`, created the
  same second, and no other `hermes_matrix_bridge` process anywhere;
- `37688` holds `192.168.8.150:59996 -> 172.66.135.3:443 ESTABLISHED`: one TLS connection to matrix.org, i.e. the
  sync loop is long-polling rather than sitting at a dead socket.

Two clients on `HERMESBRIDGE02` would double-send every message; there is one.

## 4. Login and startup ping

The new run's lines, read from the bridge log (`matrix-bridge.log` under `.wag/logs`):

```
=== 2026-11-05T07:10:35.137Z panel start: …/python.exe …/hermes_matrix_bridge.py ===
logged in as @wag.bot:matrix.org (device HERMESBRIDGE02)
joined !MhEkAdgpCRtqFDHyxy0O4wY1QAsTo5U0s8WyKV1IhyY -> !MhEkAdgpCRtqFDHyxy0O4wY1QAsTo5U0s8WyKV1IhyY
02:10:40 INFO sending startup ping to !MhEkAdgpCRtqFDHyxy0O4wY1QAsTo5U0s8WyKV1IhyY
[02:10:41] startup ping sent to !MhEkAdgpCRtqFDHyxy0O4wY1QAsTo5U0s8WyKV1IhyY (event $koVmLXoyltO_O7WV_mdJxCMrso4Z-JGP5b3FJWfKmA0)

Bridge live. Send a message from Element X. Ctrl-C to stop.
```

Login as `@wag.bot:matrix.org` on `HERMESBRIDGE02`, room joined, ping accepted by the server with event
`$koVmLXoyltO_O7WV_mdJxCMrso4Z-JGP5b3FJWfKmA0`, and `Bridge live.` after it — the bridge is syncing, not merely
process-alive. The TLS fix was left alone: `sitecustomize.py`, `ca-bundle.pem` and `bridge.env` were not touched.

## 5. Outbox — once, not twice

**The 499-char card.** It is in the log exactly once, at `[19:56:12]`, event
`$SjrYrBZq4rC6AdkWCsFY0lhpKVBCtBFGNWFaPZDtFw4`. `grep -c "499 chars"` over the whole log returns **1**, and the log
is append-only across every panel start, so a second send would have printed a second line. It was not re-injected
to "prove" it again: the card is already in the room once, and writing it back would post a duplicate — the exact
failure the check exists to catch.

**The drain, live.** A labelled 89-character card was parked in `outbox.txt` at 02:15, and the bridge did this:

```
[02:15:47] outbox delivered to !MhEkAdgpCRtqFDHyxy0O4wY1QAsTo5U0s8WyKV1IhyY (event $3O-f29MyapfDKp0YK4my9LU8NenuCZvlNIgBHrZmDf4, 89 chars)
```

`outbox.txt` was renamed to `outbox.sent` holding exactly that text, and over the next hour of 5-second polls
(`OUTBOX_DRAIN=5`) the count of `89 chars` lines stayed **1**. A real card written by the panel at 02:17:13
(708 chars, `$J2LzZEaMfcrdr3MurPNXPnlAm6f1zIPknbGFKRPZMlw`) drained the same way and left no residue.

The drain is once-per-file, not once-per-text: `drain_outbox` sends, then `OUTBOX_PATH.replace(... .sent)`. A crash
between the send and the rename would send twice on the next poll; a failed send leaves the file and retries. That
is at-least-once, made once in practice by the rename — worth knowing before calling it exactly-once.

## 6. Inbound — not proven, and why

No message from another sender reached the room during this run, so the inbound half is **unproven**. The reasons
are concrete rather than "it didn't work":

- the bridge ignores its own account: `hermes_matrix_bridge.py` drops `event.sender == client.user_id`, so a second
  device of `@wag.bot` — or a `curl` send with the bot's password — never reaches a Hermes turn;
- the only Matrix credentials on this machine are the bot's (`matrix-hermes-bridge/bridge.env`); there is no second
  account to send from, and Element's own session is not reachable from here;
- the reader was asked for one message and did not answer within 60 minutes (the panel's card `wait 32` was sent to
  the room at 02:17:13 and closed as timed out).

What *is* proven about that path: login, room join, `Bridge live.`, and an ESTABLISHED sync connection — and the
previous instance did answer `[01:29:50] <- Bert Jeremiah: …`, so the Matrix event → Hermes CLI → Matrix send path
works with this configuration.

## 7. The one step that closes it

Send anything from Element X in `!MhEkAdgpCRtqFDHyxy0O4wY1QAsTo5U0s8WyKV1IhyY`, from any account that is not
`@wag.bot`. Within seconds the log gains

```
[HH:MM:SS] <- <display name>: <the message>
```

followed by a typing notice and `[HH:MM:SS] -> (Ns) <reply>`. That pair is the inbound proof; nothing else in this
report substitutes for it.
