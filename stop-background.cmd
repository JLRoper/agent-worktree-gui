@echo off
rem Stop the detached worktree monitor started by start-background.cmd.
rem The pid file is in the panel's DATA directory (%WAG_HOME%\logs, default %USERPROFILE%\.wag\logs),
rem not in this checkout -- see start-background.cmd.
setlocal
cd /d "%~dp0"
if not defined WAG_HOME set "WAG_HOME=%USERPROFILE%\.wag"
set "LOGDIR=%WAG_HOME%\logs"
if not exist "%LOGDIR%\server.pid" (
  echo No "%LOGDIR%\server.pid" -- nothing to stop.
  exit /b 0
)
set /p PID=<"%LOGDIR%\server.pid"
taskkill /PID %PID% /T /F >nul 2>nul
if errorlevel 1 (
  echo PID %PID% was not running.
) else (
  echo Stopped PID %PID%.
)
del "%LOGDIR%\server.pid" >nul 2>nul
exit /b 0
