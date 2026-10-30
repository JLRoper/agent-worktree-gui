# Restart App with Latest Changes

Pulls the latest commits from `origin/main`, kills any running Node processes, and starts the server fresh.

## Steps

1. Run `git pull origin main` from the project root to get latest changes
2. Kill any running Node.js processes with `taskkill /F /IM node.exe` (ignore errors if none running)
3. Wait 2 seconds for cleanup
4. Start the app with `start.cmd` from the project root
5. The app will be available at http://127.0.0.1:7331
