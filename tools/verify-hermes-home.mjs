// One Hermes home, for every reader.
//
// lib/activity.js used to carry its own `hermesHome()` — the third copy in the tree, and the only one
// without the MSYS guard and the HOME fallback the other two have. The difference is not academic on
// this box: with HERMES_HOME written the MSYS way (`/c/Users/.../hermes`, which native Hermes cannot
// resolve), that copy sent the session reader to a state.db that does not exist while every other
// Hermes read in the panel fell back to the real home. Nothing threw, nothing logged: the session
// chips and the driest liveness signal just went quiet.
//
// Two things are proved here, and both are driven:
//
//   1. the reader finds the session store every other reader names, under all three shapes of
//      HERMES_HOME — native, MSYS-shaped, and absent (a real state.db is built in a sandbox and the
//      reader is run in a CHILD process, so the answer is the reader's own and not this file's cache);
//   2. there is exactly ONE definition of the home in lib/, so a fourth copy cannot appear quietly.
//
// The pre-fix tree fails check 1 under the MSYS shape (the reader returns nothing) and the fix makes it
// pass; the counterfactual is stated in the header rather than re-run here, the way the other scripts in
// tools/ state theirs.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const os = await import("node:os");

let checks = 0;
let failures = 0;
const check = (name, got, want) => {
  checks += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};

// ---- a throwaway Hermes home with one real session in it ----------------------------------------
const sandbox = path.join(os.tmpdir(), `wtgui-hermes-home-${Math.random().toString(36).slice(2, 8)}`);
const fallbackHome = path.join(sandbox, "hermes"); // what LOCALAPPDATA/hermes resolves to here
const nativeHome = path.join(sandbox, "elsewhere", "hermes"); // what a native HERMES_HOME names
const WORKTREE = path.join(sandbox, "scan-root", "sandbox-repo", ".worktrees", "a-session-lived-here-abc123");
mkdirSync(fallbackHome, { recursive: true });
mkdirSync(nativeHome, { recursive: true });
mkdirSync(WORKTREE, { recursive: true });

const { DatabaseSync } = await import("node:sqlite");
const buildStore = (home) => {
  const db = new DatabaseSync(path.join(home, "state.db"));
  db.exec(
    "create table sessions (id text primary key, title text, cwd text, last_activity_at real, ended_at real);" +
      "create table session_turn_leases (conversation_id text, expires_at real);" +
      "create table messages (id integer primary key, session_id text, role text, content text, timestamp real);",
  );
  db.prepare("insert into sessions (id, title, cwd, last_activity_at, ended_at) values (?,?,?,?,?)").run(
    "wtgui-a-session-abc123",
    "a session that lived here",
    WORKTREE,
    Date.now() / 1000,
    null,
  );
  db.prepare("insert into messages (session_id, role, content, timestamp) values (?,?,?,?)").run(
    "wtgui-a-session-abc123",
    "user",
    `work in ${WORKTREE}`,
    Date.now() / 1000,
  );
  db.close();
};
buildStore(fallbackHome);
buildStore(nativeHome);

// The MSYS shape points at a home that does not exist, which is the whole point: a reader that trusts it
// finds nothing, and a reader that shares hermes-runtime.js falls back to LOCALAPPDATA.
const msysShaped = "/c/Users/Jacob/AppData/Local/hermes";

// ---- the child: run the panel's own reader and print what it sees --------------------------------
const childPath = path.join(sandbox, "read-sessions.mjs");
writeFileSync(
  childPath,
  `import { hermesSessions } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "lib", "activity.js")).href)};
import { hermesHome } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "lib", "hermes-runtime.js")).href)};
import { hermesConfigPath } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "lib", "hermes-config.js")).href)};
const raw = await hermesSessions().catch(() => null);
console.log(JSON.stringify({
  home: hermesHome(),
  configPath: hermesConfigPath(),
  resolvedNothing: raw === null,
  sessions: (raw || []).map((s) => ({ id: s.id, cwd: s.cwd, running: s.running, open: s.open })),
}));
`,
  "utf8",
);

const readWith = (env) => {
  const res = spawnSync(process.execPath, [childPath], {
    env: { ...env },
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (res.status !== 0) {
    console.log("      child failed:", String(res.stderr || "").split("\n").slice(-6).join("\n      "));
    return null;
  }
  return JSON.parse(res.stdout.trim().split("\n").pop());
};

// `env` is built from scratch, not from process.env: the machine's own HERMES_HOME must not leak in.
const base = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LOCALAPPDATA: sandbox, USERPROFILE: process.env.USERPROFILE };

console.log("== the reader under a NATIVE Hermes home (what every other read in the panel uses) ==");
const native = readWith({ ...base, HERMES_HOME: nativeHome });
check("the reader names the home HERMES_HOME gave it", native?.home, nativeHome);
check("and finds the session in that store", native?.sessions.map((s) => s.cwd), [WORKTREE.replace(/\\/g, "/").toLowerCase()]);
check("with the session's own liveness read off it", native?.sessions[0]?.open, true);

console.log("\n== the reader under an MSYS-shaped Hermes home (the shape native Hermes cannot use) ==");
const msys = readWith({ ...base, HERMES_HOME: msysShaped });
check("the MSYS shape is refused, and the fallback home is named instead", msys?.home, fallbackHome);
check("the config reader agrees with it, to the file", msys?.configPath, path.join(fallbackHome, "config.yaml"));
check("the reader did not quietly resolve to nothing", msys?.resolvedNothing, false);
check(
  "and the session reader finds the SAME store the rest of the panel reads",
  msys?.sessions.map((s) => s.cwd),
  [WORKTREE.replace(/\\/g, "/").toLowerCase()],
);

console.log("\n== the reader with no HERMES_HOME at all ==");
const absent = readWith({ ...base });
check("the fallback home is used", absent?.home, fallbackHome);
check("and the session is still found", (absent?.sessions || []).length, 1);

console.log("\n== one home, one definition ==");
const libFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (entry.endsWith(".js")) libFiles.push(full);
  }
};
walk(path.join(ROOT, "lib"));
const definers = libFiles.filter((f) => /function\s+hermesHome\b|\bhermesHome\s*=\s*\(/.test(readFileSync(f, "utf8")));
check(
  "exactly one file in lib/ defines hermesHome, and it is lib/hermes-runtime.js",
  definers.map((f) => path.relative(ROOT, f).replace(/\\/g, "/")),
  ["lib/hermes-runtime.js"],
);
const readers = libFiles.filter((f) => /hermesHome\(/.test(readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f).replace(/\\/g, "/"));
ok(
  "and every other module that needs it imports it rather than re-declaring it",
  readers.every((f) => f !== "lib/activity.js" || /from "\.\/hermes-runtime\.js"/.test(readFileSync(path.join(ROOT, f), "utf8"))),
  readers.join(", "),
);

rmSync(sandbox, { recursive: true, force: true });
console.log(`\n== summary ==\n${checks} checks, ${failures} failed.`);
console.log("driven in a sandbox of its own (own LOCALAPPDATA, own Hermes home, a real state.db with one");
console.log("session in it, the panel's own reader run in a child process); no live panel or gateway touched.");
if (failures) console.log("RESULT: HERMES-HOME-FAILED");
else console.log("RESULT: HERMES-HOME-OK");
process.exit(failures ? 1 : 0);
