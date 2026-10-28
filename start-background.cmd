@echo off
rem Start the worktree monitor detached (no console window, survives this shell).
rem
rem The panel's own log and pid file live in its LOG folder, never in this checkout. Which folder is asked of
rem tools\where.mjs, i.e. of the same code the server runs (lib/paths.js), so a "dataDir" written in config.json,
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
set "LOGDIR="
for /f "usebackq delims=" %%i in (`node "%~dp0tools\where.mjs" logs`) do set "LOGDIR=%%i"
if not defined LOGDIR (
  echo Could not work out the log folder: tools\where.mjs printed nothing.
  pause
  exit /b 1
)
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "PIDFILE="
if exist "%LOGDIR%\server.pid" set "PIDFILE=%LOGDIR%\server.pid"
if not defined PIDFILE if exist "logs\server.pid" set "PIDFILE=logs\server.pid"
if defined PIDFILE (
  call :check "%PIDFILE%"
  if errorlevel 1 exit /b 1
)
powershell -NoProfile -Command ^
  "$p = Start-Process -FilePath (Get-Command node).Source -ArgumentList 'server.js' -WorkingDirectory '%CD%' -WindowStyle Hidden -PassThru -RedirectStandardOutput '%LOGDIR%\server.out.log' -RedirectStandardError '%LOGDIR%\server.err.log'; Set-Content -Path '%LOGDIR%\server.pid' -Value $p.Id -Encoding ascii; Write-Host ('started PID ' + $p.Id + ' -- log: %LOGDIR%\server.out.log')"
echo.
echo Monitor: http://localhost:7331
echo Stop with stop-background.cmd
exit /b 0

:check
rem A separate label, not inline in the block above: inside ( ... ) every %VAR% is expanded when the block is parsed,
rem BEFORE set /p has run, so an inline check always saw an empty PID and never refused a second start.
set "OLDPID="
set /p OLDPID=<%1
if not defined OLDPID exit /b 0
call :alive %OLDPID%
if errorlevel 1 exit /b 0
echo Already running as PID %OLDPID% -- use stop-background.cmd first.
exit /b 1

:alive
rem findstr, not find: on a PATH that carries Git's usr\bin, "find" is GNU find and always answers "not running".
tasklist /FI "PID eq %1" 2>nul | findstr /c:" %1 " >nul
if errorlevel 1 exit /b 1
exit /b 0
