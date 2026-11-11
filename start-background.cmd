@echo off
rem Start the worktree monitor detached (no console window, survives this shell).
rem
rem The panel's own log and pid file live in its LOG folder, never in this checkout. Which folder is asked of
rem tools\start-background.mjs, i.e. of the same code the server runs (lib/paths.js), so a "dataDir" written in config.json,
rem WAG_HOME, a PANEL_CONFIG instance and the default (%USERPROFILE%\.wag\logs) all agree between this script, the
rem server and the panel's own restart. A panel started before the data directory existed has its pid file in
rem logs\ beside this script: that one is honoured too, so the first stop or start after upgrading still finds it.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH.
  pause
  exit /b 1
)
node "%~dp0tools\start-background.mjs"
if errorlevel 1 exit /b 1
echo.
echo Monitor: http://localhost:7331
echo Stop with stop-background.cmd
exit /b 0
