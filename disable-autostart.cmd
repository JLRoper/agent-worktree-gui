@echo off
rem Remove the auto-start registration created by enable-autostart.cmd.
rem This does not stop a currently running instance -- use stop-background.cmd for that.
setlocal

reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" ^
  /v "agent-worktree-gui" ^
  /f >nul 2>nul

if errorlevel 1 (
  echo No auto-start entry found -- nothing to remove.
  exit /b 0
)

echo.
echo Auto-start disabled.
echo.
echo agent-worktree-gui will no longer start at login.
echo The current instance (if running) is not affected -- use stop-background.cmd to stop it.
echo.
