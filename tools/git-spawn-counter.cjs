// The spawn counter behind tools/measure-git-spawns.mjs.
//
// Preload this with `--require` and every git process the panel STARTS is appended to
// `$WAG_GIT_COUNT_LOG`: one line per spawn, with the moment, the pid and the first frame outside the
// child-process plumbing. That is a process-creation count - one line is one `git.exe` this process
// asked the OS to start - not a sample of how many happen to be alive.
//
// WHERE it hooks matters. Patching `child_process.execFile` looks right and measures nothing: lib/project.js
// and lib/child-tree.js reach `execFile` through `util.promisify`, whose custom path calls the module's OWN
// `execFile`, not the exported one - and wrapping the export also DROPS `promisify.custom`, which made every
// main-thread call resolve a bare string instead of `{stdout, stderr}` ("cannot read properties of undefined
// (reading 'replace')"). So the hook is one level below all of them: `ChildProcess.prototype.spawn`, the one
// door every asynchronous child process (execFile, exec, spawn) goes through exactly once, carrying
// `options.file` and `options.args`.
//
// Worker threads are separate isolates whose `node:child_process` a main-thread patch never reaches. A
// `--require` module runs in every worker thread as well (worker_threads inherits `process.execArgv`), so the
// patch is in place in the scan pool's workers too, which is where the per-row git runs.
//
// The patch is deliberately narrow: only `git` (and `git.exe`) is counted, and the original method runs with
// its arguments untouched. Nothing about the panel's behaviour changes.
const cp = require("node:child_process");
const fs = require("node:fs");

const LOG = process.env.WAG_GIT_COUNT_LOG || "";
const PHASE = () => process.env.WAG_PHASE || "-";

const isGit = (cmd) => typeof cmd === "string" && /(^|[\\/])git(\.exe)?$/i.test(cmd.trim());

// The plumbing frames are the same for every call, so they say nothing about WHICH read spawned this
// git: drop them and keep the first frame that is about the panel's own code.
const PLUMBING = /[\\/](child-tree|scan|scan-worker)\.js:/;
function caller() {
  let stack = "";
  try {
    stack = String(new Error().stack || "");
  } catch {
    return "unknown";
  }
  const frames = [];
  for (const line of stack.split("\n").slice(1)) {
    const m = /(?:file:\/\/\/)?([A-Za-z]:[\\/][^)\s]*[\\/](?:lib|tools|server)[\\/]?[\w.-]*\.js):(\d+)/.exec(line);
    if (m) frames.push(`${m[1].replace(/\\/g, "/")}:${m[2]}`);
  }
  const interesting = frames.find((f) => !PLUMBING.test(f));
  return interesting || frames[frames.length - 1] || "unknown";
}

function note(cmd, args) {
  if (!LOG || !isGit(cmd)) return;
  const flat = (Array.isArray(args) ? args : []).map(String).join(" ").replace(/\s+/g, " ").slice(0, 160);
  try {
    fs.appendFileSync(LOG, `${Date.now()}\t${process.pid}\t${PHASE()}\t${caller()}\t${flat}\n`);
  } catch {
    /* a measurement that cannot write its own log is over; never break the panel for it */
  }
}

const proto = cp.ChildProcess && cp.ChildProcess.prototype;
if (proto && typeof proto.spawn === "function" && !proto.spawn.__wagCounted) {
  const original = proto.spawn;
  const wrapped = function (options) {
    try {
      note(options && options.file, options && options.args);
    } catch {
      /* counting must never be the reason a child fails to start */
    }
    return original.call(this, options);
  };
  wrapped.__wagCounted = true;
  proto.spawn = wrapped;
}
