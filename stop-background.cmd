@echo off
rem Stop the detached worktree monitor started by start-background.cmd.
rem The pid file is in the panel's LOG folder, which tools\where.mjs works out with the same code the server runs
rem (see start-background.cmd). A panel started before the data directory existed has it in logs\ beside this
rem script: that one is stopped too, so upgrading never strands a running panel.
setlocal
cd /d "%~dp0"
set "LOGDIR="
where node >nul 2>nul
if not errorlevel 1 for /f "usebackq delims=" %%i in (`node "%~dp0tools\where.mjs" logs 2^>nul`) do set "LOGDIR=%%i"
set "PIDFILE="
if defined LOGDIR if exist "%LOGDIR%\server.pid" set "PIDFILE=%LOGDIR%\server.pid"
if not defined PIDFILE if exist "logs\server.pid" set "PIDFILE=logs\server.pid"
if not defined PIDFILE (
  echo No server.pid in "%LOGDIR%" or in "%CD%\logs" -- nothing to stop.
  exit /b 0
)
set /p PID=<"%PIDFILE%"
taskkill /PID %PID% /T /F >nul 2>nul
if errorlevel 1 (
  echo PID %PID% was not running.
) else (
  echo Stopped PID %PID%.
)
del "%PIDFILE%" >nul 2>nul
exit /b 0
