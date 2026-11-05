# Matrix bridge

A standalone Python process that puts a Hermes agent in a Matrix room: a message posted in the room is
run through the local Hermes CLI as a one-shot inference, and the answer is posted back to the same room.
It is not part of the Node panel and has no Node dependency — the panel only starts, stops and watches it.

This directory is the canonical copy of the bridge. It was copied verbatim from a working external
checkout on the development machine, so the scripts, the install runbook and the panel live in
one repository. The four `.py` files were scanned for credentials before copying; none contain a token,
password, room id or other secret. The only credentials file is `bridge.env`, which is **not** in this
repository and must never be.

| File | What it is |
| --- | --- |
| `hermes_matrix_bridge.py` | the bridge itself (Matrix ↔ Hermes, E2EE, outbox, pid lock) |
| `restart_bridge.py` | delayed stop-then-start helper, run detached by the next file |
| `start_restart.py` | fires `restart_bridge.py` detached and exits |
| `verify_restart.py` | detached witness: 120 s later, records the new bridge's state |
| `WAG-PROMPT.md` | the original brief for the panel-side integration (historical documentation) |
| `bridge.env.example` | configuration template — placeholders only |
| `README.md` | this runbook |

---

## 1. What the bridge is and does

`hermes_matrix_bridge.py` is a long-running Matrix client built on
[matrix-nio](https://github.com/matrix-nio/matrix-nio) with E2EE through vodozemac (no libolm build).
It does five things:

1. **Logs in** as one bot account with `MATRIX_PASSWORD` and a pinned `MATRIX_DEVICE_ID`, so the E2EE
   device and its keys survive restarts.
2. **Joins one room** (`MATRIX_ROOM_ID`) and ignores every other room and every invite — it does not
   auto-join invites.
3. **Turns each text message into an inference**: the text plus the last `BRIDGE_HISTORY_TURNS` turns is
   passed to the local `hermes` CLI as a one-shot run, and the reply is chunked (30,000-character guard)
   and posted back. A typing notice is refreshed every `TYPING_REFRESH` seconds while the turn runs.
4. **Drains an outbox**: any text parked in `outbox.txt` (or `BRIDGE_OUTBOX`) is posted at startup and
   polled every `OUTBOX_DRAIN` seconds, then renamed to `outbox.sent`. This is the channel a long-running
   turn uses for "still working" notes, and it survives a restart.
5. **Owns one instance**: `MATRIX_STORE_DIR/bridge.pid` is a lock. A second copy pointed at the same store
   exits with `Another bridge is already running (pid N). Stop it first.` — two clients sharing one Olm
   store corrupt it.
6. **Obeys the panel, per turn**: before each inference it fetches `GET /api/matrix/policy` and
   `GET /api/matrix/reminders` from the panel (see §10), appends the two preambles to the prompt, and sends
   nothing from a cache — an edit in the Bridge tab is in force on the next message. A failed fetch is
   printed at the TOP of the reply (`⚠ I could not read the panel policy this turn …`) instead of the bot
   silently running on the last text it saw. The reminder list is the bridge's OWN; the assistants' watches
   ride in the same answer as a READ-ONLY view, and the bridge has no code path that writes one.

Every launch also posts the fixed line `Hermes is online and ready!` to the room, and prints
`Bridge live. Send a message from Element X. Ctrl-C to stop.` once it is syncing.

Modes:

```
hermes_matrix_bridge.py                  # run the bridge (default)
hermes_matrix_bridge.py --self-test      # config/deps/hermes check, no network
hermes_matrix_bridge.py --rooms          # log in, list joined + invited rooms
hermes_matrix_bridge.py --once "text"    # one local inference, no Matrix
```

---

## 2. Prerequisites

- **Python 3.10+** — the working install is CPython **3.14.9**. Older 3.9 may work; 3.14 is what is
  verified here.
- **A virtual environment** in this directory (`.venv`). Not committed; create it.
- **Packages**: `matrix-nio[e2e]` (the working install pins **0.26.0**, which brings **vodozemac 0.10.0**,
  `aiohttp`, `peewee`, `pycryptodome`, `jsonschema`). No `certifi` is used — see §5.
- **The Hermes CLI** installed on the same machine and runnable by the account that runs the bridge.
  `HERMES_BIN` may point at it; otherwise the script searches `PATH`,
  `%LOCALAPPDATA%\hermes\hermes-agent\.hermes\bin\hermes.exe`, and `~/.local/bin/hermes`.
- **A dedicated Matrix bot account** whose homeserver permits **password login**. An account that is
  SSO-only cannot be used: the bridge logs in with `m.login.password`.
- **Network egress** to the homeserver. If the machine is behind the SEFL TLS-inspecting proxy, the CA
  bundle in §5 is required.
- **Windows** for the restart helpers (`restart_bridge.py`, `start_restart.py`) — they use PowerShell,
  `taskkill` and `CREATE_NO_WINDOW`/detached process flags. The bridge itself is portable Python.

---

## 3. Create the venv and install

From this directory (git-bash on Windows):

```bash
cd matrix-bridge
python -m venv .venv
./.venv/Scripts/python.exe -m pip install --upgrade pip
./.venv/Scripts/python.exe -m pip install "matrix-nio[e2e]==0.26.0"
```

PowerShell equivalent:

```powershell
cd matrix-bridge
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install "matrix-nio[e2e]==0.26.0"
```

On Linux/macOS the interpreter is `.venv/bin/python` instead of `.venv/Scripts/python.exe`.

Prove the imports before going further:

```bash
./.venv/Scripts/python.exe -c "import nio, vodozemac; print(nio.__version__, vodozemac.__version__)"
```

`matrix-nio[e2e]` is the only package you install by hand; the rest are its dependencies. Do not install
`certifi` expecting it to fix TLS — this install deliberately uses the bundle in §5.

---

## 4. Configure `bridge.env`

### Where the file must live

`bridge.env` must be **beside `hermes_matrix_bridge.py`**, i.e. at `matrix-bridge/bridge.env`. The script
resolves it as `Path(__file__).with_name("bridge.env")`; it does not read a path from an argument, a
variable, or the current directory. The panel's "credentials present" check is the same rule: it tests
`<directory of scriptPath>/bridge.env`.

```bash
cd matrix-bridge
cp bridge.env.example bridge.env
```

Then fill it in. `bridge.env` holds the Matrix password in plain text. Never commit it, never copy it into
another directory, never paste it into a ticket or a chat. It is covered by `.gitignore`; verify with
`git check-ignore -v matrix-bridge/bridge.env`.

### Every variable the code reads

| Variable | Required | Default in code | What to put / where to get it |
| --- | --- | --- | --- |
| `MATRIX_HOMESERVER` | yes | `https://matrix.org` | Base URL of the homeserver, no `/_matrix` suffix — the URL you use to log in with Element. |
| `MATRIX_USERNAME` | yes | `@wag.bot:matrix.org` (example) | The bot's full user id, `@localpart:server`. Create a dedicated account; do not use a person's account. |
| `MATRIX_PASSWORD` | yes | `CHANGE_ME` | **Secret.** The bot account's password. Set at account creation, or changed in Element → Settings → Account. With `CHANGE_ME` still in it, the bridge refuses to start. |
| `MATRIX_ROOM_ID` | yes | `!CHANGE_ME:matrix.org` | The one room to serve, `!opaque:server`. See "Room id and access token" below. |
| `MATRIX_DEVICE_ID` | no | `HERMESBRIDGE` | Stable E2EE device name. Keep it constant; changing it makes the bot a new untrusted device and old encrypted history unreadable. |
| `MATRIX_STORE_DIR` | no | `~/.hermes-matrix-store` | Directory for the Olm key store (`matrix_store.db`), sync state, and `bridge.pid`. One per account/device. Deleting it loses the keys. |
| `HERMES_BIN` | no | empty → auto-detect | Full path to `hermes.exe` (not the `.cmd` shim) if auto-detection fails. |
| `HERMES_TOOLSETS` | no | empty → Hermes default | Comma-separated toolsets the bot may use, e.g. `web,terminal`. See the security warning in §12. |
| `HERMES_TIMEOUT` | no | `300` | Seconds one inference may run before it is cut off. |
| `TYPING_REFRESH` | no | `20` | Seconds between typing notices; must stay below Matrix's ~30 s expiry. |
| `BRIDGE_HISTORY_TURNS` | no | `12` | How many previous turns are replayed as context. |
| `BRIDGE_OUTBOX` | no | `outbox.txt` beside the script | File polled for one-line status messages; renamed to `outbox.sent` after delivery. |
| `OUTBOX_DRAIN` | no | `5` | Seconds between outbox polls. |
| `WTGUI_PANEL_URL` | no | `http://127.0.0.1:7331` | Base URL of the panel whose policy and reminder list the bridge reads on every turn. The panel sets it for the child it spawns, from the port it bound; set it for a foreground run on another port. |
| `WTGUI_PANEL_TOKEN` | no | empty | Only for a panel on ANOTHER host. A loopback request needs no token. It is a credential — leave empty on a normal install and never commit a filled copy. |
| `WTGUI_PANEL_TIMEOUT` | no | `5` | Seconds one panel GET may take before the turn runs without it (and says so in its reply). |
| `LOCALAPPDATA` | OS-set | — | Read only to auto-detect `hermes.exe` on Windows. Do not put it in `bridge.env`. |

Format rules, from the loader in `hermes_matrix_bridge.py`:

- `KEY=VALUE`, one per line; `#` starts a comment **only at the start of a line** — an inline comment
  becomes part of the value.
- Surrounding single or double quotes are stripped; there is no shell expansion.
- A key already present in the process environment **wins** over the file. That is useful for a one-off
  override (`MATRIX_ROOM_ID='!x:y' ./.venv/Scripts/python.exe hermes_matrix_bridge.py`) and is why the
  loader can be re-run safely.
- A UTF-8 BOM is tolerated.

### Room id and access token

**Room id.** The bridge needs the internal id (`!opaque:server`), not the `#alias` and not the display
name.

1. In Element, invite the bot account to the room (the bridge does not auto-join invites).
2. Run the probe, which logs in and lists what the account can see:

   ```bash
   ./.venv/Scripts/python.exe hermes_matrix_bridge.py --rooms
   ```

   It prints `logged in as <user> on device <device>`, then a `JOINED:` block, then an `INVITED:` block,
   each row shaped `<room id>  <display name>`, and ends with
   `Paste the one you want into ROOM_ID in bridge.env`. If the room is only under `INVITED:`, accept the
   invite first (or re-run after the bot has joined).
3. Put the `!...:server` value into `MATRIX_ROOM_ID`.

Element also shows it: Room settings → Advanced → **Internal room ID**.

**Access token.** The bridge has **no access-token variable** — it logs in with `MATRIX_PASSWORD` at every
start, and matrix-nio holds the resulting token in memory. If you need a token for `curl` or another
client, obtain one from the same login endpoint (this is exactly what the bridge does; the response's
`access_token` normally starts with `syt_`):

```bash
curl -s -X POST "https://matrix.org/_matrix/client/v3/login" \
  -H "Content-Type: application/json" \
  -d '{"type":"m.login.password",
       "identifier":{"type":"m.id.user","user":"@REPLACE_WITH_BOT_USER:matrix.org"},
       "password":"REPLACE_WITH_THE_BOT_ACCOUNT_PASSWORD",
       "initial_device_display_name":"manual probe"}'
```

The response carries `access_token`, `device_id` and `user_id`. Treat that token exactly like the
password: it is a bearer credential for the account. Do **not** add it to `bridge.env` (nothing reads it)
and do **not** commit it. The token is invalidated by a password change and by logging the device out.

---

## 5. The CA bundle (`ca-bundle.pem`)

**Not committed. Not copied into this repository.** `.gitignore` names it so a local copy cannot be
committed by accident.

**Where it is expected:** `matrix-bridge/ca-bundle.pem`, beside `hermes_matrix_bridge.py`. Nothing in the
four scripts loads it by filename; it is wired in through the **venv**, which is why it must be at that
fixed path for the provided `sitecustomize.py` (below) to find it.

**Where it comes from.** This host's outbound TLS goes through a SEFL inspection appliance whose
self-signed CA is `CN=csc1fw004.sefl.com`. That appliance re-signs the leaves for `matrix.org` /
`element.io`. `ca-bundle.pem` is the PEM trust bundle exported from that Windows machine's Trusted Root
store: **109 certificates**, including the appliance's own CA, SEFL's internal roots (`CN=SEFLCA1`,
`sefl-SEFLADC3-CA`, `sefl-CSCVDC03-CA` and others) and the normal public roots. Obtain it from SEFL IT,
or export it on the machine that will run the bridge:

```powershell
# Run this from matrix-bridge/; it writes the bundle beside the scripts.
$out = Join-Path $PWD "ca-bundle.pem"
Get-ChildItem Cert:\LocalMachine\Root | ForEach-Object {
  "-----BEGIN CERTIFICATE-----"
  [Convert]::ToBase64String($_.RawData, 'InsertLineBreaks')
  "-----END CERTIFICATE-----"
} | Set-Content -Encoding ascii $out
```

**Why a bundle is not enough by itself.** The appliance's CA and the leaves it issues carry no Authority
Key Identifier extension. OpenSSL 3.x (and therefore this Python build) enables `VERIFY_X509_STRICT` by
default and rejects the chain with `Missing Authority Key Identifier`. The working install fixes this in
the venv with a `sitecustomize.py` that points OpenSSL at the bundle and clears only the strict flag —
certificate and hostname verification stay **on**:

```python
# .venv/Lib/site-packages/sitecustomize.py
import os, ssl

_BUNDLE = r"<absolute path to matrix-bridge>\ca-bundle.pem"

if os.path.isfile(_BUNDLE):
    os.environ.setdefault("SSL_CERT_FILE", _BUNDLE)
    _orig = ssl.create_default_context

    def _create_default_context(*args, **kwargs):
        kwargs.setdefault("cafile", _BUNDLE)
        ctx = _orig(*args, **kwargs)
        try:
            ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
        except Exception:
            pass
        return ctx

    ssl.create_default_context = _create_default_context
```

Create that file after the venv exists, with `_BUNDLE` set to the **absolute** path of this install's
`ca-bundle.pem`. On Linux the path is `.venv/lib/python3.X/site-packages/sitecustomize.py`.

If the machine is **not** behind the inspection proxy, skip the bundle entirely: stock Python roots work,
and a missing bundle makes the `sitecustomize.py` block above a no-op. Never "fix" TLS by disabling
verification.

---

## 6. Start it

Normal operation is the panel's **Start** button (see §10); it spawns this interpreter and script and owns
the process. For a foreground run (debugging, or a host with no panel):

```bash
cd matrix-bridge
./.venv/Scripts/python.exe hermes_matrix_bridge.py
```

What you should see, in order:

- a `joined <ROOM_ID> -> <canonical room id>` line;
- a `startup ping sent to <room> (event <id>)` line, and the room receives
  `Hermes is online and ready!`;
- the line `Bridge live. Send a message from Element X. Ctrl-C to stop.`

`Ctrl-C` stops it cleanly enough; the pid lock is removed by the `atexit` handler.

Do not start a second copy against the same `MATRIX_STORE_DIR`: the pid lock refuses it, because two
clients sharing one Olm store corrupt the E2EE state.

---

## 7. Verify it is alive

### Config, dependencies and the Hermes binary (no network)

```bash
cd matrix-bridge
./.venv/Scripts/python.exe hermes_matrix_bridge.py --self-test
echo $?
```

Exit code **0** means the config is filled in, matrix-nio and its E2EE backend import, and the Hermes
binary was found. The output is a block in exactly this shape (values vary by install):

```
config:
  HOMESERVER = https://matrix.org
  USERNAME   = @example-bot:matrix.org
  PASSWORD   = set
  ROOM_ID    = !example-room:matrix.org
  DEVICE_ID  = HERMESBRIDGE
  STORE_DIR  = <store dir>
matrix-nio: OK (<venv>\Lib\site-packages\nio)
e2ee:       OK (vodozemac)
hermes bin: <hermes>\bin\hermes.exe
```

`<store dir>`, `<venv>` and `<hermes>` stand for the absolute paths on your install; the labels and the
`OK` / `set` values are what matters.

A failure prints `PASSWORD = MISSING` (plus `! PASSWORD still CHANGE_ME`), `matrix-nio: FAILED — <reason>`,
or `hermes bin: NOT FOUND`, and exits non-zero. `--self-test` does **not** contact the homeserver.

### Login and room visibility

```bash
./.venv/Scripts/python.exe hermes_matrix_bridge.py --rooms
```

This is the network check: it logs in with the configured password and prints `logged in as ...`, then the
`JOINED:` and `INVITED:` blocks described in §4. A login failure prints `LOGIN FAILED: <message>` and exits
non-zero; a sync failure prints `SYNC FAILED: <message>`.

### The running process

- The log (stdout in a foreground run, `logs/matrix-bridge.log` under the panel's data directory when the
  panel started it) contains `Bridge live.` after the startup ping.
- `MATRIX_STORE_DIR/bridge.pid` contains the live pid:

  ```bash
  cat "$HOME/.hermes-matrix-store/bridge.pid"
  ```

  On Windows, confirm that pid exists: `Get-Process -Id (Get-Content "$HOME\.hermes-matrix-store\bridge.pid")`.
- The panel's Gateway tab shows the running state and the pid (§10).

### End to end

Send `hello` from a second account in the room. Expect a typing notice, then a reply from the bot. This is
the only check that proves the full path (Matrix event → Hermes CLI → Matrix send); the two commands above
prove config and login separately.

The sender has to be a **different account**. The bridge drops every event whose sender is its own user id
(`if event.sender == client.user_id` in `on_room_message`), so a second device of the bot account — or a
`curl` login with `MATRIX_PASSWORD` — is received and ignored. With only the bot's credentials on the machine
the inbound half cannot be exercised at all; do not read the silence as a broken bridge.

---

## 8. Restart it with `restart_bridge.py`

The bridge cannot restart itself from inside a turn it is answering: killing the parent would lose the
reply. The helper waits first, then restarts.

```bash
cd matrix-bridge
./.venv/Scripts/python.exe start_restart.py 30
```

`start_restart.py [delay]` (default `30` seconds) starts `restart_bridge.py` fully detached and exits
immediately; it prints `restart helper launched: <pid>`. `restart_bridge.py` then:

1. reads the legacy pid file `~/.hermes-matrix-store2/bridge.pid` (if present);
2. waits `delay` seconds — long enough for the current turn's reply to be delivered;
3. finds every `python.exe` whose command line contains `hermes_matrix_bridge.py` (via PowerShell
   `Get-CimInstance`), adds the legacy pid, and runs `taskkill /F /PID` on each;
4. deletes the legacy pid file, appends a `===== restart <timestamp> =====` banner to `bridge_live.log`,
   and starts a fresh detached bridge with `.venv/Scripts/python.exe` from this directory, with stdout and
   stderr going to `bridge_live.log`;
5. writes each step to stdout and to `restart_report.txt`.

Watch the result:

```bash
tail -n 40 bridge_live.log
cat restart_report.txt
```

`restart_report.txt` should end with `new bridge started: pid <n>`; `bridge_live.log` should gain a new
banner followed by the `joined` / `startup ping` / `Bridge live.` lines. `verify_restart.py` is a separate
witness: run it (it sleeps 120 seconds, detached if you like) and it writes `restart_verify.txt` with the
pid file's value, whether `outbox.txt` is present, and the last 25 lines of `bridge_live.log`.

Caveats, because these helpers predate the module layout:

- They are **Windows-only** and hardcode `HERE/.venv/Scripts/python.exe`. If your venv is elsewhere, use
  the panel's Stop/Start instead.
- `restart_bridge.py` and `verify_restart.py` read `~/.hermes-matrix-store2/bridge.pid`, a **legacy**
  helper pid file. The bridge's authoritative lock is `MATRIX_STORE_DIR/bridge.pid` (default
  `~/.hermes-matrix-store/bridge.pid`). The command-line match is what actually finds the process, so the
  restart works even when the legacy file is missing or stale.

---

## 9. What each script does

| Script | Runs as | What it does |
| --- | --- | --- |
| `hermes_matrix_bridge.py` | long-lived process | Logs in, joins `MATRIX_ROOM_ID`, fetches the panel's policy and reminder list per turn, runs each room message through the Hermes CLI, posts replies, drains the outbox, refreshes typing, enforces the single-instance pid lock. Modes: default run, `--self-test`, `--rooms`, `--once "text"`. |
| `restart_bridge.py` | detached child of `start_restart.py` | Waits `delay` seconds, kills every bridge process it can find, removes the legacy pid file, starts a fresh detached bridge writing to `bridge_live.log`, and appends to `restart_report.txt`. |
| `start_restart.py` | short-lived launcher | Takes an optional delay (default 30), fires `restart_bridge.py` detached with that delay, writes `restart_launcher.log`, prints the helper's pid, and exits. This is the command a turn uses when it needs a restart without killing its own reply. |
| `verify_restart.py` | detached witness | Sleeps 120 seconds, then writes `restart_verify.txt`: the legacy pid file's contents, whether `outbox.txt` still exists, and the last 25 lines of `bridge_live.log`. It changes nothing else. |
| `WAG-PROMPT.md` | documentation | The original brief that specified the panel's Gateway-tab integration: config block, ownership, routes, UI, verification. Kept as design history. The absolute paths in it name the original external checkout; in this repository the scripts live here, in `matrix-bridge/`. |

Runtime files the bridge and helpers create (all ignored by git):

| File | Created by | Meaning |
| --- | --- | --- |
| `bridge.env` | you | credentials — **secret** |
| `outbox.txt` / `outbox.sent` | bridge | pending / already-delivered status text |
| `bridge.pid` (in `MATRIX_STORE_DIR`) | bridge | single-instance lock, live pid |
| `matrix_store.db` (in `MATRIX_STORE_DIR`) | matrix-nio | E2EE keys and sync state — sensitive |
| `bridge_live.log` | restart helper | detached bridge stdout/stderr |
| `restart_report.txt` | restart helper | what the restart did |
| `restart_verify.txt` | verify helper | post-restart witness |
| `restart_launcher.log` | launcher | detached launcher output |
| `ca-bundle.pem` | you / IT | TLS trust bundle (§5) |

---

## 10. How the panel uses it

The panel is the Node app in this repository. `lib/matrix-bridge.js` owns only the process lifecycle; it
never speaks Matrix and never reads `bridge.env`.

`config.json` carries a `matrix` block with exactly four keys:

```json
"matrix": {
  "scriptPath": "<absolute path to repo>/matrix-bridge/hermes_matrix_bridge.py",
  "pythonPath": "<absolute path to repo>/matrix-bridge/.venv/Scripts/python.exe",
  "roomId": "!REPLACE_WITH_ROOM_ID:matrix.org",
  "autoStart": true
}
```

Write absolute paths for the installing machine; the panel hands them straight to `spawn`.

- `scriptPath` — `hermes_matrix_bridge.py` in this directory.
- `pythonPath` — the venv interpreter created in §3.
- `roomId` — the same room as `MATRIX_ROOM_ID`; the panel shows it and refuses Start when it is empty.
- `autoStart` — when true (the default when absent), the panel starts the bridge once during server boot if
  the script exists, `bridge.env` is present beside it, a room is set, and no live pid is recorded.

What the Gateway tab does:

- **Start** spawns `<pythonPath> <scriptPath>` detached, with the script's directory as the working
  directory, and appends stdout+stderr to `logs/matrix-bridge.log` in the panel's data directory. A second
  Start while the recorded pid is alive is refused with `409`.
- **Stop** kills the process tree (`taskkill /T /F` on Windows), so the Hermes child goes too.
- **Run self-test** runs `<pythonPath> <scriptPath> --self-test` and reports its exit code and output.
- **State** is the OS's answer about the recorded pid, not the pid file's existence: a record left by a
  crash reads as stopped (`stalePid`) and never blocks a new start.
- `credentialsPresent` is only `existsSync(<dir of scriptPath>/bridge.env)`. The panel never opens, parses
  or echoes that file, so the password cannot reach a route, a log line or the browser.

The assistant float's **Bridge** tab is the reader's other view of the same process, and it does not run a
second copy of any of the above. It reads `GET /api/matrix/status` — the bridge state above, the Element
channel's recent inbound/outbound records, the policy, the bridge's reminder list, and a fresh gateway probe —
and draws six sections: connection (pid, live/dead, the PATH of `bridge.env`, the room and its sender rule, last
send/receive), messages (the newest ten each way, failures highlighted, never a full transcript), policy,
reminders, the assistants' watches (read-only), and alerts (bridge health, gateway reachability, send failures).

- **Policy** is one markdown file in the panel's state folder, served at `GET`/`POST /api/matrix/policy`. The
  bridge fetches it on EVERY turn and appends the answer's `preamble` to the prompt, so an edit is in force on
  the next message with no restart. Its text wins over the `WTGUI_MATRIX_POLICY` environment default. It is not
  a variable in `bridge.env`, and the panel still never reads that file.
- **Reminders** are the bridge's OWN list, in `matrix-reminders.json`, served at `GET`/`POST
  /api/matrix/reminders`. They are deliberately not an assistant's watches: a reminder has no thread and wakes
  nobody, and the bridge keeps NO task queue — work it files belongs to an assistant's queue. The panel is the
  only writer; the bridge reads the list per turn.
- **Watches** are projected from the assistants for reading only (`watchesReadOnly`, `readOnly` on every row).
  `POST /api/matrix/reminders` refuses any body naming a watch field before it touches the file, so the bridge
  can mention a watch on the phone and can never create, complete or delete one.

The bridge does not need the panel to run, and the panel does not need the bridge to run. If you install
the module in a new checkout, update the `matrix` block (Gateway tab → Save, or `config.json`) to the new
paths; the committed `config.json` still points at the original external checkout by design, so this
module can land without disturbing the running endpoint.

---

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `--self-test` prints `PASSWORD = MISSING` / `! PASSWORD still CHANGE_ME` | `bridge.env` missing, in the wrong directory, or still the template | Put a filled `bridge.env` beside `hermes_matrix_bridge.py`; the password must not contain `CHANGE_ME`. |
| `hermes bin: NOT FOUND` and exit non-zero | Hermes CLI is not on `PATH` and not in the standard locations | Set `HERMES_BIN` to the full path of `hermes.exe`; re-run `--self-test`. |
| `LOGIN FAILED: Invalid password` / `M_FORBIDDEN` | wrong `MATRIX_PASSWORD`, or the account requires SSO | Correct the password; if the account is SSO-only, create a dedicated bot account that permits password login. |
| Login worked before, now `LOGIN FAILED` with `M_UNKNOWN_TOKEN` / 401 | password changed, or the `HERMESBRIDGE` device was logged out | Update `MATRIX_PASSWORD`, restart; the bridge logs in again at every start. |
| `JOIN FAILED for !…` / the room never appears | bot was never invited or never joined | Invite the bot, accept/join the room, run `--rooms`, copy the `JOINED:` id into `MATRIX_ROOM_ID`. |
| Bot is running but replies in the wrong room / not at all | `MATRIX_ROOM_ID` is an alias, a display name, or another room; or the room is only under `INVITED:` | Use the internal `!opaque:server` id from `--rooms`; invited rooms are deliberately ignored. |
| `Another bridge is already running (pid N). Stop it first.` | a second copy is using the same `MATRIX_STORE_DIR` | Stop the other process (panel Stop, or `taskkill /F /PID N`). Only delete `bridge.pid` after confirming that pid is dead. |
| `ssl.SSLCertVerificationError` / `CERTIFICATE_VERIFY_FAILED` / `Missing Authority Key Identifier` | the inspection proxy's CA is not trusted by this venv | Install `ca-bundle.pem` at `matrix-bridge/ca-bundle.pem` and add the `sitecustomize.py` from §5; do not disable verification. |
| The panel's Gateway tab says the gateway is unreachable | that is the **Hermes gateway**, not the Matrix bridge | Check the panel's Hermes gateway/`API_SERVER_KEY` setup. The bridge shells out to the Hermes CLI and does not use the gateway. |
| Nothing is posted from `outbox.txt` | file is empty, was already delivered (renamed `outbox.sent`), or the send failed | Put non-empty text in the configured `BRIDGE_OUTBOX`; check the log for `outbox send failed` — the file is left in place on failure. `.sent` is the normal success state. |
| A reply is missing, or the bot types forever | Hermes inference failed or exceeded `HERMES_TIMEOUT` | Run `--once "hello"` to test the CLI locally; raise `HERMES_TIMEOUT` if the turn is legitimately long; check the log for the worker exception. |
| Every reply starts with `⚠ I could not read the panel policy this turn` | the panel is not running, or `WTGUI_PANEL_URL` names the wrong port/host | Start the panel, check `curl <WTGUI_PANEL_URL>/api/matrix/policy` answers, and send again — nothing is cached, so the next turn picks the policy up. |
| An old message gets no reply after a restart | events from before the process started are skipped by design | Send the message after `Bridge live.` appears. |
| `undecryptable event` warnings | the sender's device is not trusted / keys were lost with the store | Keep `MATRIX_DEVICE_ID` and `MATRIX_STORE_DIR` stable; re-verify the bot's device in Element if the store was deleted. |

---

## 12. Security

- **`bridge.env` is the secret.** It contains the Matrix account password in plain text. It must never be
  committed, copied, pasted into an issue, or printed in a log. `.gitignore` covers `bridge.env`;
  `git check-ignore -v matrix-bridge/bridge.env` must name the rule before you commit anything.
- **The panel never reads it.** `credentialsPresent` is a file-existence check. Do not put the password in
  `config.json` (the panel's save route drops unknown keys, but the file would still be on disk) and do not
  send it through the panel's routes.
- **Access tokens are passwords.** If you obtain one with `curl` for debugging, it is a bearer credential:
  keep it out of shell history you share, out of tickets, and out of this repository.
- **Rotate on leak.** Change the bot account's password in Element (this invalidates existing access
  tokens), log out the `HERMESBRIDGE` device, then restart the bridge with the new `MATRIX_PASSWORD`. If
  the E2EE store may have been exposed, delete `MATRIX_STORE_DIR` and start fresh — that creates a new
  device, and old encrypted history will no longer be decryptable by the bot.
- **The store directory is sensitive too.** `matrix_store.db` holds the device's Olm/Megolm keys. It lives
  under the user's home by default and is never committed. Back it up only to protected storage.
- **Room membership is tool access.** A message in the room becomes a Hermes prompt. With
  `HERMES_TOOLSETS` including `terminal`, anyone who can post in that room can cause command execution as
  the account running the bridge. Keep the room private and invite-only, use a dedicated bot account, and
  grant the minimum toolset. Treat an invited guest like a shell user.
- **Logs and the outbox contain message text and room ids.** They are runtime files (`*.log`,
  `outbox.txt`, `outbox.sent`) and are ignored; do not attach them to tickets without reading them first.
- **`ca-bundle.pem` is public certificate material, not a secret**, but it is machine-specific and is not
  committed. The private keys it certifies never leave the appliance.
- The four `.py` files and `WAG-PROMPT.md` were scanned for `syt_` tokens, `access_token`, `secret`,
  password literals, long opaque literals and private room ids before being copied. None were found; the
  only paths by which a credential enters the system are `bridge.env` (the password) and the login
  response (the in-memory token).
