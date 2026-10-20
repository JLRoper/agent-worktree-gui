@echo off
rem Start the worktree monitor detached (no console window, survives this shell).
rem Logs go to logs\server.log; the PID is written to logs\server.pid.
setlocal
cd /d "%~dp0"
if not exist logs mkdir logs
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH.
  pause
  exit /b 1
)
if exist logs\server.pid (
  set /p OLDPID=<logs\server.pid
  call :alive %OLDPID%
  if errorlevel 1 (
    echo Already running as PID %OLDPID% -- use stop-background.cmd first.
    exit /b 1
  )
)
powershell -NoProfile -Command ^
  "$p = Start-Process -FilePath (Get-Command node).Source -ArgumentList 'server.js' -WorkingDirectory '%CD%' -WindowStyle Hidden -PassThru -RedirectStandardOutput 'logs\server.out.log' -RedirectStandardError 'logs\server.err.log'; Set-Content -Path 'logs\server.pid' -Value $p.Id -Encoding ascii; Write-Host ('started PID ' + $p.Id)"
echo.
echo Monitor: http://localhost:7331
echo Stop with stop-background.cmd
exit /b 0

:alive
tasklist /FI "PID eq %1" 2>nul | find "%1" >nul
if errorlevel 1 exit /b 1
exit /b 0
