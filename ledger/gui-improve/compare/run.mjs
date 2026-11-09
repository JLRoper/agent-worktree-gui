// gui-improve compare - reproduce the after set from this tree.
//
// The baseline's before set is committed at 44b4278 (ledger/gui-improve/baseline/). This script builds the
// after tree as 44b4278 + the change-set's public/ hunks, boots it as a throwaway panel on port 7493 with
// the baseline's two scan roots, runs capture.mjs against it, and copies the new set into compare/after/.
// Nothing in public/ or lib/ of THIS checkout is touched: the after tree is a git archive in the temp dir.
//
//   PLAYWRIGHT_BROWSERS_PATH=C:/Users/roper/AppData/Local/ms-playwright \
//   NODE_PATH=C:/Users/roper/AppData/Roaming/npm/node_modules \
//   node ledger/gui-improve/compare/run.mjs
//
// Set KEEP_AFTER_TREE=1 to keep the temp tree for inspection.
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startPanel } from "../../../tools/panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const AFTER_COMMIT = "44b4278";
const PORT = Number(process.env.PANEL_PORT || 7493);
const KEEP = process.env.KEEP_AFTER_TREE === "1";

const dir = await mkdtemp(path.join(os.tmpdir(), "wag-gui-improve-after-"));
const tarPath = path.join(dir, "base.tar");
const tree = path.join(dir, "tree");
await mkdir(tree, { recursive: true });

console.log(`after tree: ${AFTER_COMMIT} + change-set, built in ${tree}`);
execFileSync("git", ["-C", ROOT, "archive", "--format=tar", AFTER_COMMIT, "-o", tarPath], { stdio: "inherit" });
// The MSYS tar in this shell reads a C:/ path as a remote host; use the Windows bsdtar when it exists.
const tarExe = process.platform === "win32" && existsSync("C:/Windows/System32/tar.exe") ? "C:/Windows/System32/tar.exe" : "tar";
execFileSync(tarExe, ["-xf", tarPath, "-C", tree], { stdio: "inherit" });
execFileSync("git", ["apply", "--unsafe-paths", "-p1", "--include=public/*", path.join(HERE, "change-set.patch")], {
  cwd: tree,
  stdio: "inherit",
});

// git archive on Windows writes CRLF working copies; normalise the two patched text files so the served
// bytes are the same ones the committed after capture recorded.
for (const name of ["public/index.html", "public/style.css"]) {
  const p = path.join(tree, name);
  const buf = await readFile(p);
  if (buf.includes(Buffer.from("\r\n"))) await writeFile(p, Buffer.from(buf.toString("binary").replace(/\r\n/g, "\n"), "binary"));
}

const capSrc = await readFile(path.join(HERE, "capture.mjs"));
await mkdir(path.join(tree, "ledger/gui-improve/compare"), { recursive: true });
await writeFile(path.join(tree, "ledger/gui-improve/compare/capture.mjs"), capSrc);

const panel = await startPanel({
  port: PORT,
  root: tree,
  config: {
    scanRoots: ["C:/CodeReviews", "C:/sefl-mvn-local"],
    projects: [],
    threads: 2,
    refreshSeconds: 60,
    worktreeSeconds: 60,
  },
});
console.log(`panel ${panel.base} (pid ${panel.pid})`);

const child = spawn(process.execPath, [path.join(tree, "ledger/gui-improve/compare/capture.mjs")], {
  cwd: tree,
  env: {
    ...process.env,
    PANEL_BASE: panel.base + "/",
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || "C:/Users/roper/AppData/Local/ms-playwright",
    NODE_PATH: process.env.NODE_PATH || "C:/Users/roper/AppData/Roaming/npm/node_modules",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
const code = await new Promise((resolve) => child.on("exit", (c, signal) => resolve(c ?? (signal ? 1 : 0))));

try {
  await panel.stop();
} catch (e) {
  console.error(`panel stop failed: ${e.message || e}`);
}

if (code !== 0) {
  console.error(`\ncapture failed with exit ${code}\n--- panel log ---\n${panel.log()}`);
  process.exit(code);
}

const from = path.join(tree, "ledger/gui-improve/compare/after");
const to = path.join(HERE, "after");
await cp(from, to, { recursive: true, force: true });
console.log(`capture complete; after/ refreshed from ${from}`);
if (!KEEP) await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
else console.log(`kept ${dir}`);
