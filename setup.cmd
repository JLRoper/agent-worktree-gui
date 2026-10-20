@echo off
rem First-run checks for the worktree panel. Nothing is installed; this only verifies the
rem prerequisites and tells you what is missing. Safe to re-run.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode
for /f "delims=." %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODEMAJOR=%%v
if %NODEMAJOR% LSS 18 goto oldnode
echo [ok]   node %NODEMAJOR%

where git >nul 2>nul
if errorlevel 1 goto nogit
echo [ok]   git

where hermes >nul 2>nul
if errorlevel 1 (echo [warn] hermes not on PATH -- monitoring works, spawning agents will not) else (echo [ok]   hermes)

if exist config.json (
  echo [ok]   config.json present -- check "scanRoots" points at where your repos live
) else (
  echo [info] no config.json -- the panel will start on defaults ^(scanRoots = the parent folder^)
)

echo.
echo Ready.  Start it with:  start.cmd        then open  http://127.0.0.1:7331
echo Docs:   README.md  and  SETUP.md
exit /b 0

:nonode
echo [x]    node not found on PATH -- install Node 18 or newer (https://nodejs.org)
exit /b 1

:oldnode
echo [x]    node %NODEMAJOR% is too old -- the panel needs Node 18 or newer
exit /b 1

:nogit
echo [x]    git not found on PATH -- the panel reads every worktree with it
exit /b 1
