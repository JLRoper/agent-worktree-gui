# Plan: Worktree Monitor behind a local FQDN, with Docker

Status: **Track A is built and running.** Tracks B and C are the two ways to put the
*application itself* in a container, with what each one costs on this machine.

```
http://worktree.localhost:8088      <- use this
https://worktree.localhost:8443     <- same, TLS via Caddy's local CA
```

Both are published on `127.0.0.1` only. The panel itself still runs on the Windows
host as PID `logs/server.pid`; the container is the front door.

---

## 1. What the app needs from Windows (measured, not assumed)

The panel is not a normal web app: it shells out to `git` for every worktree and reads
Windows process state for its liveness chips. Three hard constraints, each verified on
this box today:

| Constraint | Evidence |
| --- | --- |
| Linked worktrees carry **absolute Windows gitdirs** | `C:/Users/roper/.local/share/kilo/worktree-pool/oauth2-multi-92df4788c542/mahogany-caraway/.git` contains `gitdir: C:/ProjectDevelopment/oauth2-multi/.git/worktrees/mahogany-caraway` |
| That path is unusable in a Linux container | `docker run --rm --entrypoint sh -v C:/:/c alpine/git -c 'cd .../mahogany-caraway && git status'` → `fatal: not a git repository: (null)` |
| Docker Desktop bind mounts are slow for git | `git status` on `C:/ProjectDevelopment/Menu`: **0.217s** on the host, **2.19s** in a container (~10×). The scheduler re-reads ~109 worktrees every 5–30s |
| Liveness chips need Windows tools | `lib/activity.js` runs `tasklist` and `netstat`; 109/109 rows currently carry `hermes`, `board` and `ports` signals |
| Agent spawning needs `hermes.exe` | `lib/jobs.js` spawns the Hermes CLI; a Linux container has no Hermes, no worktree branches |

So a Linux container can serve the UI but would show **broken rows for every linked
worktree**, no liveness chips, and no "Spawn agent" — i.e. most of what the panel is for.
That is why the front door, not the scheduler, is what goes in Docker.

## 2. Track A — Docker front door (implemented)

```
docker/docker-compose.yml     caddy:2-alpine, two loopback ports, SSE passthrough
docker/caddy/Caddyfile        catch-all :80 and name-bound :443 (tls internal)
```

Caddy reaches the panel through `host.docker.internal`, which Docker Desktop proxies to
the Windows host's loopback — verified: the container fetched `/api/health` from a
service bound to `127.0.0.1:7331`, so the panel never has to bind a LAN interface.

### Run it

```
cd C:/ProjectDevelopment/agent-worktree-gui/docker && docker compose up -d
```

### Check it

```
curl -s --resolve worktree.localhost:8088:127.0.0.1 -o /dev/null -w "%{http_code} %{time_total}s\n" http://worktree.localhost:8088/api/health
docker logs worktree-frontdoor --tail 20
```

### Notes

- `*.localhost` resolves to loopback in Chrome/Edge/Firefox by spec — no hosts-file edit
  needed. For non-browser tools (curl, PowerShell, Java) add
  `127.0.0.1 worktree.localhost` to `C:\Windows\System32\drivers\etc\hosts`, or just use
  `http://127.0.0.1:7331`.
- HTTPS serves a certificate from Caddy's internal CA (12-hour certs, auto-renewed), so the
  browser warns until the CA is trusted. To remove the warning once:

  ```
  docker cp worktree-frontdoor:/data/caddy/pki/authorities/local/root.crt C:/Users/roper/AppData/Local/hermes/cache/scratch/caddy-root.crt
  ```

  then, in an elevated prompt: `certutil -addstore -f Root C:\Users\roper\AppData\Local\hermes\cache\scratch\caddy-root.crt`.
  Plain HTTP on 8088 avoids all of this.
- **Do not publish 8088/8443 on `0.0.0.0`.** The panel spawns agent processes, so LAN
  exposure is unauthenticated RCE. If it ever must be reachable off-box, set `"token"` in
  `config.json` and have Caddy inject `x-panel-token` (write endpoints check it).
- Stop: `docker compose down` (the panel keeps running; `stop-background.cmd` stops that).

## 3. Track B — the app in a Linux container

What works: plain repositories (`git status` inside the container is correct), the UI,
`/api/state`, verdicts for non-worktree projects, PR lookup if `gh`+token are mounted.

What breaks, with the error observed above:

1. Every linked worktree → `fatal: not a git repository: (null)`. 109 rows today, most of
   them worktrees. Fixing this needs the panel to rewrite `gitdir:` pointers or to resolve
   worktrees via `git --git-dir` — a code change in `lib/scan.js`, and it would fork the
   on-disk state the host also reads.
2. 10× slower git on bind mounts → the 5s/30s cadence cannot be met; `threads: 4` would
   saturate the VM. Workable only with `dormantSeconds` ≥ 120 and `fetchSeconds` ≥ 3600.
3. Liveness chips (`tasklist`, `netstat`, Hermes `state.db`) → gone or wrong. A port of
   `lib/activity.js` to `/proc` is possible but reads *container* processes, not yours.
4. Agent spawning → impossible without a Hermes install in the image and a mount of
   `~/.hermes`; worktree creation would then happen inside the container's view of the repo.

Verdict: only worth it if you also move the repos into the Docker/WSL filesystem
(clone fresh there). Then the paths are container-native and worktrees work — but the panel
would be watching a *copy* of your repos, not the ones you edit in `C:\ProjectDevelopment`.

## 4. Track C — a Windows container (would work, expensive)

Windows containers see the same `C:\` paths, have `tasklist`/`netstat`, and can mount the
Hermes install, so the app would run unmodified. Costs:

- Docker Desktop must switch to **Windows containers** mode, which stops every Linux
  container you are running — including the `oauth2-web-apache-tomcat` container that has
  been up 24h.
- Base image is `mcr.microsoft.com/windows/servercore` or `node:lts-nanoserver` (~4–6 GB),
  plus Git for Windows inside it.
- Agent spawning would still need `C:\Users\roper\AppData\Local\hermes` and `hermes.exe`
  mounted, plus the OpenRouter key available to the container.

Verdict: technically the correct containerisation of this app, but it is a heavy, disruptive
setup for a single-user dev panel that already works natively.

## 5. Recommendation

1. Keep **Track A**. You get `http://worktree.localhost:8088` today with no functional loss
   and no LAN exposure.
2. If the goal is "one command brings the whole thing up", wrap the host process too:
   a `docker compose` profile cannot start a Windows process, but `start-background.cmd`
   already does it in one command, and `docker compose up -d` finishes the job.
3. Revisit Track B only if the repos move to WSL/container-native storage; at that point the
   only code change needed is dropping the Windows liveness sources, not the git layer.
