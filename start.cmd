@echo off
rem Double-click launcher for the worktree GUI.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH. Install it, then re-run this file.
  pause
  exit /b 1
)
node server.js
echo.
echo Server stopped. Press any key to close.
pause >nul
