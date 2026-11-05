> **Where this brief came from.** This is the original specification for the panel's Gateway-tab
> integration, kept as design history. The paths it gave were absolute paths in the external checkout
> the bridge originally lived in; in this repository the scripts are in `matrix-bridge/`, and
> `config.json`'s `matrix.scriptPath` / `matrix.pythonPath` should point there.
> The rest is verbatim apart from those paths. Some decisions here were later superseded by the code —
> the panel now has an `autoStart` flag that defaults to on, and every landing carries a version bump.
> Treat `README.md` and the code as current. No credentials appear in this file.

Add Matrix bridge control to the Settings -> Gateway tab in agent-worktree-gui.

Context: a working two-way Matrix<->Hermes bridge already exists as a standalone
Python script. Do not rewrite it, do not move its logic into the panel, and do not
add Matrix/E2EE handling to Node:

  script:      hermes_matrix_bridge.py (this module)
  venv python: .venv/Scripts/python.exe (this module)
  credentials: bridge.env, beside the script (homeserver, user, password, room id,
               device id, store dir) — never committed

Its contract, which the panel may rely on:
  - `--self-test` exits 0 when config, matrix-nio and the hermes binary are OK,
    non-zero otherwise, and prints a short readable block to stdout.
  - a normal run prints the line `Bridge live.` once it is syncing; it writes its
    own single-instance pid file inside its store dir and refuses a second copy.
  - `--rooms` lists rooms; `--once "<text>"` runs one local inference.
  - it sends a fixed startup message to the room every time it launches.

Build only the panel side:

1. config.json: add a `matrix` block with scriptPath, pythonPath and roomId
   (defaults above). No secrets in config.json — the password stays in bridge.env
   and the panel must never read it.

2. Ownership: the panel spawns and stops the bridge as a detached child, using the
   same style as the existing detached spawns in server.js (~line 3190 and ~4670):
   args array, windowsHide, never a concatenated shell string. Redirect the child's
   stdout and stderr to a log file in the panel's state dir and remember its pid.

3. Routes, following the existing `if (route === "/api/..." && req.method === ...)`
   pattern in server.js:
   - GET  /api/settings/matrix        -> { running, pid, scriptPath, pythonPath,
                                           roomId, credentialsPresent,
                                           selfTest: { ok, output }, log: last 40 lines }
   - POST /api/settings/matrix/start  -> 409 while a live pid exists, otherwise spawn,
                                         return { running, pid }
   - POST /api/settings/matrix/stop   -> terminate the process tree (Windows:
                                         taskkill /T /F on the pid), return { running: false }
   - POST /api/settings/matrix/test   -> run --self-test and return { ok, output, exitCode }
   Judge liveness with the Windows-safe pid check the panel already uses; a stale pid
   file is not "running".

4. UI: a new block inside the Gateway settings panel (public/index.html
   #settings-panel-gateway, data-settings-group="gateway") with a status dot, the room
   id, the script path as read-only text, Start / Stop / Run self-test, and a mono log
   preview. Every control carries a title attribute in the house style: what it does,
   what it does not touch, what the user should expect to see. Poll on the same cadence
   as the other settings reads — do not add a second timer.

5. Behaviour rules:
   - Start is disabled, with the reason in its title, when the bridge is running or the
     script path does not exist.
   - Stop is safe to press when nothing is running (no error).
   - credentialsPresent is a boolean only; no secret ever reaches the browser.
   - The panel must not auto-start the bridge on boot.

6. Verification: add tools/verify-matrix-bridge.mjs in the existing harness style,
   driving a fake bridge script in a temp dir (prints "Bridge live.", sleeps, exits on
   SIGTERM) so the test never touches the real Matrix account. Assert start -> running
   within N seconds with "Bridge live." in the log, a second start -> 409, stop ->
   running false. Wire it into `npm run verify` and keep `npm run verify:all` green.

7. Add a CHANGELOG.md entry. Do not bump the version.

Definition of done: verify:all green, the fake-bridge harness passing, and the PR body
stating that the real bridge script was never launched during testing.
