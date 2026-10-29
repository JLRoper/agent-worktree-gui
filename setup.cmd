@echo off
rem First-run checks for the worktree panel. Nothing is installed; this only verifies the
rem prerequisites and tells you what is missing. Safe to re-run.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode
for /f "tokens=1,2 delims=." %%a in ('node -p "process.versions.node.split('.').slice(0,2).join('.')"') do (
  set NODEMAJOR=%%a
  set NODEMINOR=%%b
)
if %NODEMAJOR% LSS 22 goto oldnode
if %NODEMAJOR% EQU 22 if %NODEMINOR% LSS 5 goto oldnode
echo [ok]   node %NODEMAJOR%.%NODEMINOR%

where git >nul 2>nul
if errorlevel 1 goto nogit
echo [ok]   git

where hermes >nul 2>nul
if errorlevel 1 (echo [warn] hermes not on PATH -- monitoring works, spawning agents will not) else (echo [ok]   hermes)

if exist config.json (
  echo [ok]   config.json present -- if it names no "scanRoots", the board asks where your repos live
) else (
  echo [info] no config.json -- the panel starts on defaults and the board asks where your repos live
)

echo.
echo Ready.  Start it with:  start.cmd        then open  http://127.0.0.1:7331
echo Docs:   README.md  and  SETUP.md
exit /b 0

:nonode
echo [x]    node not found on PATH -- install Node 22.5 or newer (https://nodejs.org)
exit /b 1

:oldnode
echo [x]    node %NODEMAJOR%.%NODEMINOR% is too old -- the panel needs Node 22.5 or newer (node:sqlite)
exit /b 1

:nogit
echo [x]    git not found on PATH -- the panel reads every worktree with it
exit /b 1
