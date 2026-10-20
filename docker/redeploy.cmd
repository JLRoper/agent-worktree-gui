@echo off
rem Redeploy the Worktree Monitor to this machine's Docker Desktop front door.
rem
rem The panel runs on the host (it needs Windows worktree gitdirs, tasklist/netstat and
rem hermes.exe -- see PLAN.md); the container is the front door that gives it
rem http://worktree.localhost:8088. So a redeploy is: restart the panel from this working
rem tree, then recreate the proxy from docker/docker-compose.yml.
setlocal
cd /d "%~dp0.."

echo [1/3] restarting the panel from this working tree
call stop-background.cmd >nul 2>&1
if exist logs\server.pid del logs\server.pid >nul 2>&1
call start-background.cmd
if errorlevel 1 (
  echo Could not start the panel. See logs\server.err.log.
  exit /b 1
)

echo [2/3] recreating the front door container
pushd docker
docker compose down --remove-orphans
if errorlevel 1 goto :dockerfail
docker compose create
if errorlevel 1 goto :dockerfail
docker compose start
if errorlevel 1 goto :dockerfail
popd

echo [3/3] waiting for the panel through the proxy
rem Probe the proxy on 127.0.0.1, not on the FQDN: browsers special-case *.localhost, but the
rem Windows resolver does not, so this script would fail on DNS while the proxy was fine.
rem Caddy's catch-all :80 site answers for any Host, so an IP probe proves the same path.
powershell -NoProfile -Command ^
  "$ok = $false; for ($i = 0; $i -lt 60; $i++) { try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8088/api/health' -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { $ok = $true; break } } catch {}; Start-Sleep -Milliseconds 500 }; if ($ok) { Write-Host 'OK  http://worktree.localhost:8088  (proxied via 127.0.0.1:8088)' } else { Write-Host 'FAILED: the panel is not answering through the proxy. Check logs\server.err.log and: docker logs worktree-frontdoor'; exit 1 }"
if errorlevel 1 exit /b 1
exit /b 0

:dockerfail
popd
echo Docker Desktop did not accept the compose file. Is it running?
exit /b 1
