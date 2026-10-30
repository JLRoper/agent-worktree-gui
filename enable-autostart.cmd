@echo off
rem Register agent-worktree-gui to start automatically when you log in.
rem Uses the same registry key every Windows application uses for auto-start.
rem Run disable-autostart.cmd to undo this, or remove the entry from:
rem   HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH -- run setup.cmd first.
  pause
  exit /b 1
)

set "LAUNCH=%CD%\start-background.cmd"
if not exist "%LAUNCH%" (
  echo start-background.cmd not found in %CD%
  pause
  exit /b 1
)

reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" ^
  /v "agent-worktree-gui" ^
  /t REG_SZ ^
  /d "\"%LAUNCH%\"" ^
  /f >nul 2>nul

if errorlevel 1 (
  echo Failed to write registry key.
  pause
  exit /b 1
)

echo.
echo Auto-start enabled.
echo.
echo agent-worktree-gui will start in the background when you log in.
echo Undo with:  disable-autostart.cmd
echo.
