---
name: restart-app
description: Pull latest changes from main and restart the agent-worktree-gui app
---

# Restart App with Latest Changes

Pulls the latest commits from `origin/main`, kills any running Node processes, and starts the server fresh.

## Usage

```
/restart-app
```

## What it does

1. **Git Pull**: Fetches and merges latest changes from `origin/main`
2. **Stop Server**: Kills any running Node.js processes 
3. **Start Fresh**: Starts the app with the newly pulled code on http://127.0.0.1:7331

## How to use

Run from the Claude Code terminal:

```bash
node tools/restart-app.mjs
```

Or invoke the skill:

```
/restart-app
```

The app will start in foreground mode. Press **Ctrl+C** to stop it.

## When to use

- After resolving PR conflicts and pushing changes
- After pulling changes from the remote
- When the running server needs to reload new code
- When the page shows "connecting…" (usually means old code is running)

## Notes

- The script must be run from the project root directory
- Requires Node.js 18+
- Git must be available in PATH
- On Windows, uses `taskkill` to stop Node processes
