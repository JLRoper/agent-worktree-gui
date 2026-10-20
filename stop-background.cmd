@echo off
rem Stop the detached worktree monitor started by start-background.cmd.
setlocal
cd /d "%~dp0"
if not exist logs\server.pid (
  echo No logs\server.pid -- nothing to stop.
  exit /b 0
)
set /p PID=<logs\server.pid
taskkill /PID %PID% /T /F >nul 2>nul
if errorlevel 1 (
  echo PID %PID% was not running.
) else (
  echo Stopped PID %PID%.
)
del logs\server.pid >nul 2>nul
exit /b 0
