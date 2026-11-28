// A READ-ONLY census of the process classes this panel leaves around a machine: sandbox panels (a `server.js` this
// panel family started, usually a test's own throwaway panel) and test runners (`node --test` and the files it runs).
//
// NOTHING HERE SIGNALS A PROCESS. There is no kill, no `taskkill`, no `Stop-Process`, no `process.kill` on a censused
// pid, and the route above exposes no termination endpoint. That is deliberate: a coordinator sweep matched the live
// panel's supervisor and stopped the running instance, so v1 ships the evidence only and leaves every decision to a
// human with the pid in front of them. `orphanPids` names censused processes whose recorded parent is gone — the
// leftovers a test can leave behind — but it is a list to READ, never a queue to act on.
//
// The census is one process-table read. On Windows that is `Get-CimInstance Win32_Process` (the only cheap source of
// CreationDate and CPU time); elsewhere it is `ps`. A reader that cannot run is an empty answer, not an error: the
// Settings tab still paints its targets, and a missing census must never fail the request.
import { execFile } from "node:child_process";

// One `--test` flag, the `node:test` runner's own name, or a file named `<something>.test.js` / `.spec.mjs` under a
// `test/` folder. A bare word "test" in an argument is not enough: `server.js --test-mode` is not a runner.
const TEST_FLAG_RE = /(?:^|\s)--test(?:[=\s]|$)/;
const TEST_REPORTER_RE = /(?:^|\s)--test-reporter(?:[=\s]|$)/;
const NODE_TEST_RE = /\bnode:test\b/;
const TEST_FILE_RE = /(?:^|[\\/\s"'])test[\\/][^\s"']*\.(?:test|spec)\.(?:c|m)?js\b/i;
const PANEL_RE = /(?:^|[\\/\s"'])server\.js\b/i;

/** Does this command line read as a Node test runner or one of the test files it spawned? */
export function isTestRunnerCommandLine(commandLine) {
  const cmd = String(commandLine || "");
  if (!cmd) return false;
  return TEST_FLAG_RE.test(cmd) || TEST_REPORTER_RE.test(cmd) || NODE_TEST_RE.test(cmd) || TEST_FILE_RE.test(cmd);
}

/** Does this command line read as a panel server? Used only to CLASSIFY a census row, never to stop one. */
export function isPanelCommandLine(commandLine) {
  return PANEL_RE.test(String(commandLine || ""));
}

const isNodeName = (name) => /^node(?:\.exe)?$/i.test(String(name || "").trim());

const isoOrNull = (value) => {
  if (!value) return null;
  const ms = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

const ageOf = (startedAt, now) => {
  const ms = startedAt ? Date.parse(startedAt) : NaN;
  return Number.isFinite(ms) ? Math.max(0, Math.round((now - ms) / 1000)) : null;
};

/**
 * The pure classifier: one process-table snapshot in, the contract's three lists out.
 *
 * `rows` are `{ pid, ppid, name, created, cpuSeconds, commandLine }`. The snapshot must contain EVERY process (not
 * only Node ones), because `parentAlive` is answered from the same table: a parent present in the snapshot was alive
 * when it was read. A row whose command line cannot be read (another user's process) is still in the table for that
 * check, but cannot be classified as a panel or a runner.
 */
export function censusFromRows(rows = [], { ownPid = process.pid, now = Date.now() } = {}) {
  const table = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const pid = Number(row && row.pid);
    if (Number.isInteger(pid) && pid > 0) table.set(pid, row);
  }
  const parentAliveOf = (row) => {
    const ppid = Number(row && row.ppid);
    return Number.isInteger(ppid) && ppid > 0 && table.has(ppid);
  };

  const sandboxPanels = [];
  const testRunners = [];
  const orphanPids = [];

  for (const [pid, row] of table) {
    const commandLine = String(row.commandLine || "");
    const node = isNodeName(row.name) || /node(?:\.exe)?/i.test(commandLine);
    if (!node || !commandLine) continue;
    const startedAt = isoOrNull(row.created);
    const base = {
      pid,
      startedAt,
      ageSeconds: ageOf(startedAt, now),
      cpuSeconds: Number.isFinite(Number(row.cpuSeconds)) ? Number(row.cpuSeconds) : 0,
    };
    if (isTestRunnerCommandLine(commandLine)) {
      testRunners.push(base);
      continue;
    }
    if (pid !== Number(ownPid) && isPanelCommandLine(commandLine)) {
      const parentAlive = parentAliveOf(row);
      sandboxPanels.push({ ...base, parentAlive });
      // A panel whose launcher is gone is the leftover a test can strand. Named, never touched.
      if (!parentAlive) orphanPids.push(pid);
    }
  }

  const byPid = (a, b) => a.pid - b.pid;
  return {
    sandboxPanels: sandboxPanels.sort(byPid),
    testRunners: testRunners.sort(byPid),
    orphanPids: orphanPids.sort((a, b) => a - b),
  };
}

const EMPTY = () => ({ sandboxPanels: [], testRunners: [], orphanPids: [] });

function execText(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: 15_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(String(stdout || ""));
      },
    );
  });
}

const CENSUS_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "Get-CimInstance Win32_Process | ForEach-Object {",
  "$c = $null",
  "if ($_.CreationDate) { $c = $_.CreationDate.ToString('o') }",
  "[pscustomobject]@{ pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; name=[string]$_.Name; created=$c; cpuSeconds=[math]::Round(((([double]$_.KernelModeTime)+([double]$_.UserModeTime))/10000000),3); commandLine=[string]$_.CommandLine }",
  "} | ConvertTo-Json -Compress -Depth 3",
].join("; ");

const normaliseRows = (parsed) => {
  const list = Array.isArray(parsed) ? parsed : parsed && parsed.pid ? [parsed] : [];
  return list.map((row) => ({
    pid: Number(row.pid),
    ppid: Number(row.ppid),
    name: String(row.name || ""),
    created: row.created || null,
    cpuSeconds: Number(row.cpuSeconds) || 0,
    commandLine: String(row.commandLine || ""),
  }));
};

async function windowsRows() {
  for (const bin of ["pwsh", "powershell"]) {
    try {
      const stdout = await execText(bin, ["-NoProfile", "-NonInteractive", "-Command", CENSUS_SCRIPT]);
      const text = stdout.trim();
      if (!text) return [];
      return normaliseRows(JSON.parse(text));
    } catch {
      /* try the other shell; both missing is an empty census, never a failed request */
    }
  }
  return [];
}

// `[[dd-]hh:]mm:ss` -> seconds.
function cpuSecondsFromPs(text) {
  const parts = String(text || "").trim().split(":").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return 0;
  let days = 0;
  if (parts[0].includes("-")) {
    const [d, h] = parts.shift().split("-");
    days = Number(d) || 0;
    parts.unshift(h);
  }
  const nums = parts.map((p) => Number(p) || 0);
  const [h, m, s] = nums.length === 3 ? nums : [0, nums[0] || 0, nums[1] || 0];
  return days * 86_400 + h * 3_600 + m * 60 + s;
}

async function posixRows() {
  try {
    const stdout = await execText("ps", ["-eo", "pid=,ppid=,etimes=,time=,args="]);
    const rows = [];
    for (const line of stdout.split(/\r?\n/)) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      const age = Number(m[3]) || 0;
      const args = m[5];
      const name = (args.split(/\s+/)[0] || "").split(/[\\/]/).pop();
      rows.push({
        pid,
        ppid,
        name,
        created: Number.isFinite(age) && age >= 0 ? Date.now() - age * 1000 : null,
        cpuSeconds: cpuSecondsFromPs(m[4]),
        commandLine: args,
      });
    }
    return rows;
  } catch {
    return [];
  }
}

/**
 * The census. `readRows` is injectable so a test can hand in a snapshot instead of reading this machine's table; the
 * default reads it once and never writes anything.
 */
export async function processCensus({ readRows = null, ownPid = process.pid, platform = process.platform, now = Date.now() } = {}) {
  try {
    const rows = readRows ? await readRows() : platform === "win32" ? await windowsRows() : await posixRows();
    return censusFromRows(rows, { ownPid, now });
  } catch {
    return EMPTY();
  }
}
