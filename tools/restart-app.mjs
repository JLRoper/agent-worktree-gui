#!/usr/bin/env node
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);

console.log('🔄 Pulling latest changes from origin/main...');
try {
  execSync('git pull origin main', { cwd: projectRoot, stdio: 'inherit' });
  console.log('✓ Pull complete');
} catch (e) {
  console.error('✗ Pull failed:', e.message);
  process.exit(1);
}

console.log('\n🛑 Stopping existing app instance...');
try {
  execSync('taskkill /F /IM node.exe 2>&1', { stdio: 'inherit' });
} catch (e) {
  // OK if no process is running
}

// Wait a moment for cleanup
await new Promise(r => setTimeout(r, 2000));

console.log('\n🚀 Starting app with latest code...');
const startCmd = path.join(projectRoot, 'start.cmd');

// Spawn the app in the foreground
const proc = spawn(startCmd, [], {
  cwd: projectRoot,
  stdio: 'inherit',
  shell: true
});

proc.on('error', (err) => {
  console.error('✗ Failed to start app:', err);
  process.exit(1);
});
