@echo off
rem Start the worktree monitor detached (no console window, survives this shell).
rem
rem The panel's own log and pid file live in its DATA directory, never in this checkout:
rem %WAG_HOME%\logs, default %USERPROFILE%\.wag\logs. A "dataDir" written in config.json wins over
rem the environment, so set WAG_HOME only when you have not named one there.
setlocal
cd /d "%~dp0"
if not defined WAG_HOME set "WAG_HOME=%USERPROFILE%\.wag"
set "LOGDIR=%WAG_HOME%\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH.
  pause
  exit /b 1
)
if exist "%LOGDIR%\server.pid" (
  set /p OLDPID=<"%LOGDIR%\server.pid"
  call :alive %OLDPID%
  if not errorlevel 1 (
    echo Already running as PID %OLDPID% -- use stop-background.cmd first.
    exit /b 1
  )
)
powershell -NoProfile -Command ^
  "$p = Start-Process -FilePath (Get-Command node).Source -ArgumentList 'server.js' -WorkingDirectory '%CD%' -WindowStyle Hidden -PassThru -RedirectStandardOutput '%LOGDIR%\server.out.log' -RedirectStandardError '%LOGDIR%\server.err.log'; Set-Content -Path '%LOGDIR%\server.pid' -Value $p.Id -Encoding ascii; Write-Host ('started PID ' + $p.Id + ' -- log: %LOGDIR%\server.out.log')"
echo.
echo Monitor: http://localhost:7331
echo Stop with stop-background.cmd
exit /b 0

:alive
tasklist /FI "PID eq %1" 2>nul | find "%1" >nul
if errorlevel 1 exit /b 1
exit /b 0
