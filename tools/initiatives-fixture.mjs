#!/usr/bin/env node
// THE INITIATIVES TAB'S FIXTURE, booted on a panel of its own.
//
// WHY A MODULE. The Initiatives tab is a view of three stores at once: the initiatives file, the board's scanned
// rows, and each assistant's queue. A screenshot of an empty tab proves nothing, and a screenshot of a tab whose
// rows are invented in the page proves only that the painter can draw strings. This module writes the three stores
// the SERVER reads and then boots `server.js` against them, so every capture and every gate in this area photographs
// the real route, the real scan and the real queue read.
//
// IT KEEPS ITS OWN WAG_HOME. `lib/paths.js` resolves the data directory from WAG_HOME, and the panel's default
// install is `~/.wag` - the directory the reader's live board on 7331 is using. Booted with WAG_HOME pointing at a
// folder under scratch, this instance reads and writes nothing outside that folder. PANEL_CONFIG is NOT set: a
// second instance named by PANEL_CONFIG deliberately ignores WAG_HOME (lib/paths.js's own rule), which would put the
// fixture back on the reader's state.
//
// WHAT IS SEEDED, and why each part is here:
//   * three projects, each a real git repository with hand-cut worktrees, because `projectForPath` and the row's name,
//     branch and link all come from the scan - not from the initiatives file;
//   * four initiatives: two spanning two projects, one with a long multi-paragraph description and long unbroken
//     path tokens, and one with no worktrees at all (an empty initiative is a real state, not a bug);
//   * a `missing` tree on one initiative, so the dimmed "no longer on the board" row is in the picture;
//   * two assistants with queue rows across all four task states, so the count strips are mixed and the task folds
//     have something exact to open;
//   * a wave store on one initiative (three waves, one with two named lanes and a member from each project), so the
//     lane the redesign draws - and its 10px project tag - is in the DOM every capture and gate measures, not only in
//     the one run that remembered to seed it.
//
// The repositories are throwaway. Nothing here touches a checkout, a remote, or the reader's `~/.wag`.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, freePort, git } from "./panel-testkit.mjs";

export const KEEPER = "row-180-initiatives";

// Where the fixture lives when a caller names no home. os.tmpdir() is the scratch root the panel itself uses for
// throwaway files (lib/paths.js `scratchDir`), so a run leaves nothing beside a checkout.
export function defaultHome() {
  return path.join(os.tmpdir(), "wag", KEEPER);
}

export const PROJECTS = ["oauth2-multi", "Menu", "optym-integration-multi"];

// The worktrees, by project. A long branch on one tree is deliberate: the branch chip has to be measured against a
// name that cannot fit the rail, or "the chips fit" is a claim about a short string.
const TREES = [
  { project: "oauth2-multi", name: "menu-sso-state-cookie", branch: "wtgui/menu-sso-state-cookie-and-okta-callback-retry", initiative: "init_sso" },
  { project: "oauth2-multi", name: "token-refresh-budget", branch: "wtgui/token-refresh-budget", initiative: "init_kafka" },
  { project: "oauth2-multi", name: "session-store-audit", branch: "wtgui/session-store-audit", initiative: null },
  { project: "Menu", name: "menu-login-page", branch: "wtgui/menu-login-page", initiative: "init_sso" },
  { project: "Menu", name: "menu-role-map", branch: "wtgui/menu-role-map", initiative: "init_release" },
  { project: "Menu", name: "menu-smoke-fix", branch: "wtgui/menu-smoke-fix", initiative: null },
  { project: "optym-integration-multi", name: "event-hubs-cert", branch: "wtgui/event-hubs-cert", initiative: "init_release" },
  { project: "optym-integration-multi", name: "turnover-budget", branch: "wtgui/turnover-budget", initiative: "init_release" },
  { project: "optym-integration-multi", name: "rating-kafka-retry", branch: "wtgui/rating-kafka-retry", initiative: "init_kafka" },
];

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const hours = (n) => n * 3_600_000;

// The long description: several paragraphs, a list of facts, and two unbroken tokens. The tokens are there because
// `overflow-wrap: anywhere` is only proved by a string the browser cannot break on its own.
const LONG_DESCRIPTION = `Quarter-end release readiness for the rating and Menu surfaces. The work is not one branch: four trees across two projects have to be green before the turnover window closes on the last Friday of the quarter.

The gate is the DBA-signed verify pack plus a clean install on DEV. Anything that changes a DAL mapping waits for the pack; anything that changes a session or a cookie waits for a real two-factor login, not a mocked callback.

Open risks: the Okta callback state cookie is still replicated through SENSSTICKYSESSION, and the Event Hubs certificate rotation has no rollback path yet. The full path under audit is optym-integration-multi/src/main/java/com/sefl/rating/consumer/RatingRetryConsumer.java and the verify pack is docs/reviews/verify/2026-Q4-rating-pack.md.`;

const KAFKA_DESCRIPTION = `Hardening the rating pipeline from the consumer inward: retry topics, dead-letter handling, and a DBA-signed verify pack that can be rerun without a human reading the SQL first.

Scope:
- the retry topic, its partition count and retention;
- the consumer's idempotency key, which is the shipment number plus the rating version;
- the SQL verify pack for the two DAL mappings the retry path touches.

Out of scope: the producer schema. The producer stays on col07.sefl.com and its payload is frozen for the quarter.

The long path that keeps coming up in review is optym-integration-multi/src/main/java/com/sefl/rating/pipeline/RatingRetryTopicConfiguration.java, and the topic name is sefl.rating.retry.v2.`;

// `home` is threaded explicitly rather than through a module global: two fixtures in one process (a before run and
// an after run) must not share a store.
function treePaths(home) {
  return TREES.map((t) => ({ ...t, path: path.join(home, "repos", t.project, ".worktrees", t.name) }));
}

function treeRecord(entry, id, at) {
  return {
    path: entry.path.replace(/\\/g, "/"),
    initiatives: [id],
    members: { [id]: { at, by: id === "init_sso" ? "reader" : "assistant-2" } },
    at,
    by: id === "init_sso" ? "reader" : "assistant-2",
  };
}

export function initiativesDocument(home) {
  const trees = {};
  const attach = (entry, id, at) => {
    trees[entry.path.replace(/\\/g, "/").toLowerCase()] = treeRecord(entry, id, at);
  };
  const all = treePaths(home);
  const by = (name) => all.find((t) => t.name === name);
  // A path the board does not carry: it lives under this fixture's own home, so the line names a folder on no
  // particular machine and the row is still missing on every machine the fixture runs on.
  const missingTree = path.join(home, "state", "missing-trees", "retired-cert-probe").replace(/\\/g, "/");

  for (const entry of all.filter((t) => t.initiative)) {
    attach(entry, entry.initiative, ago(hours(entry.initiative === "init_sso" ? 52 : entry.initiative === "init_release" ? 28 : 9)));
  }
  // A tree the board no longer carries, still counted by its initiative. It is the one state a reader can only see
  // here, and the only place it can be removed from.
  trees[missingTree.toLowerCase()] = {
    path: missingTree,
    initiatives: ["init_release"],
    members: { init_release: { at: ago(hours(96)), by: "assistant-1" } },
    at: ago(hours(96)),
    by: "assistant-1",
  };

  const initiatives = [
    {
      id: "init_sso",
      title: "Menu SSO migration",
      description:
        "Move the Menu login from LDAP to Okta through oauth2-multi, keep the session cookie sticky through the VIP, and prove a real two-factor login before the login page changes for everyone.",
      createdAt: ago(hours(300)),
      updatedAt: ago(hours(6)),
      createdBy: "reader",
      updatedBy: "assistant-1",
      history: [
        { at: ago(hours(300)), by: "reader", action: "create", detail: "Menu SSO migration" },
        { at: ago(hours(52)), by: "reader", action: "attach", tree: by("menu-sso-state-cookie").path.replace(/\\/g, "/") },
        { at: ago(hours(51)), by: "reader", action: "attach", tree: by("menu-login-page").path.replace(/\\/g, "/") },
        { at: ago(hours(30)), by: "assistant-1", action: "attach", tree: by("menu-sso-state-cookie").path.replace(/\\/g, "/") },
        { at: ago(hours(6)), by: "assistant-1", action: "edit", detail: "named the two-factor check in the description" },
      ],
    },
    {
      id: "init_release",
      title: "Quarter-end release readiness",
      description: LONG_DESCRIPTION,
      createdAt: ago(hours(190)),
      updatedAt: ago(hours(21)),
      createdBy: "assistant-2",
      updatedBy: "reader",
      history: [
        { at: ago(hours(190)), by: "assistant-2", action: "create", detail: "Quarter-end release readiness" },
        { at: ago(hours(120)), by: "reader", action: "attach", tree: by("menu-role-map").path.replace(/\\/g, "/") },
        { at: ago(hours(96)), by: "assistant-1", action: "attach", tree: missingTree },
        { at: ago(hours(28)), by: "assistant-2", action: "attach", tree: by("event-hubs-cert").path.replace(/\\/g, "/") },
        { at: ago(hours(28)), by: "assistant-2", action: "attach", tree: by("turnover-budget").path.replace(/\\/g, "/") },
        { at: ago(hours(21)), by: "reader", action: "edit", detail: "added the rollback risk" },
      ],
    },
    {
      id: "init_kafka",
      title: "Kafka rating pipeline hardening across the consumer, the retry topic and the DBA-signed verify pack",
      description: KAFKA_DESCRIPTION,
      createdAt: ago(hours(80)),
      updatedAt: ago(hours(3)),
      createdBy: "assistant-1",
      updatedBy: "assistant-1",
      history: [
        { at: ago(hours(80)), by: "assistant-1", action: "create", detail: "Kafka rating pipeline hardening" },
        { at: ago(hours(44)), by: "assistant-1", action: "attach", tree: by("rating-kafka-retry").path.replace(/\\/g, "/") },
        { at: ago(hours(9)), by: "assistant-2", action: "attach", tree: by("token-refresh-budget").path.replace(/\\/g, "/") },
        { at: ago(hours(3)), by: "assistant-1", action: "edit", detail: "froze the producer schema for the quarter" },
      ],
    },
    {
      id: "init_sweeper",
      title: "Batch sweeper retry budget",
      description: "Cap the nightly sweeper's retries so a single bad shipment cannot hold the queue past the SLA. No worktree has been cut yet.",
      createdAt: ago(hours(18)),
      updatedAt: null,
      createdBy: "reader",
      updatedBy: null,
      history: [{ at: ago(hours(18)), by: "reader", action: "create", detail: "Batch sweeper retry budget" }],
    },
  ];
  return { version: 1, savedAt: new Date().toISOString(), initiatives, trees };
}

// The queue rows are the shape lib/assistant/queue.js reads. `worktree` is the SAME path the initiative store holds,
// which is the only link the tab follows: a task on a branch that merely looks like a tree does not appear here.
function queueTasks(home) {
  const by = (name) => treePaths(home).find((t) => t.name === name);
  const task = (id, title, state, name, extra = {}) => ({
    id,
    title,
    detail: extra.detail || "",
    state,
    owner: null,
    createdBy: "reader",
    createdAt: extra.createdAt || ago(hours(4)),
    startedAt: extra.startedAt || null,
    doneAt: extra.doneAt || null,
    doneBy: extra.doneBy || null,
    thread: extra.thread || `wtgui-${name}`,
    threads: [],
    project: by(name).project,
    worktree: by(name).path,
    files: [],
    lane: null,
    order: null,
    attempts: 0,
    reason: extra.reason || "",
    hold: null,
    movedFrom: [],
    runId: extra.runId || null,
  });
  return {
    "assistant-1": [
      task(11, "Validate the Okta callback against the VIP", "running", "menu-sso-state-cookie", { startedAt: ago(11 * 60_000), runId: "run_sso_11", thread: "wtgui-menu-sso-state-cookie" }),
      task(12, "Retry the state cookie on a node switch", "queued", "menu-sso-state-cookie", { createdAt: ago(4 * 60_000) }),
      task(13, "Land the Menu login page", "done", "menu-login-page", { doneAt: ago(hours(2)), doneBy: "assistant-1" }),
      task(14, "Map the two role names", "done", "menu-role-map", { doneAt: ago(hours(3)) }),
      task(15, "Rotate the Event Hubs certificate", "done", "event-hubs-cert", { doneAt: ago(hours(9)) }),
      task(16, "Wait for the DBA on the turnover pack", "parked", "turnover-budget", { reason: "waiting on the DBA", createdAt: ago(hours(20)) }),
      task(17, "Read the retry topic's partition count", "queued", "rating-kafka-retry", { createdAt: ago(35 * 60_000) }),
    ],
    "assistant-2": [
      task(21, "Second pass over the callback", "done", "menu-sso-state-cookie", { doneAt: ago(hours(26)) }),
      task(22, "Review the certificate rotation", "running", "event-hubs-cert", { startedAt: ago(3 * 60_000), runId: "run_cert_22" }),
      task(23, "Audit the retry consumer's idempotency key", "queued", "rating-kafka-retry", { createdAt: ago(90 * 60_000) }),
      task(24, "Hold the token refresh budget", "parked", "token-refresh-budget", { reason: "waiting on the Q4 freeze" }),
    ],
  };
}

function writeState(home) {
  const state = path.join(home, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, "initiatives.json"), `${JSON.stringify(initiativesDocument(home), null, 2)}\n`, "utf8");
  const assistants = [
    { id: "assistant-1", name: "Manager", roleId: "assistant-agent-manager", threadId: "panel-assistant", rules: [], createdAt: ago(hours(500)) },
    { id: "assistant-2", name: "Reviewer", roleId: "assistant-agent-manager", threadId: "panel-assistant-2", charterRel: "assistants/assistant-2/charter.md", rules: [], createdAt: ago(hours(120)) },
  ];
  writeFileSync(path.join(state, "assistants.json"), `${JSON.stringify({ version: 1, assistants }, null, 1)}\n`, "utf8");
  const queues = queueTasks(home);
  // THE WAVE STORE, so the lane the tab draws is in every measurement of it. Three waves on init_sso; wave-flip holds
  // two named lanes (cookie and login), each with one task from a different project, which is what makes the lane's
  // member rows and their 10px project tags measurable. The task ids are the fixture's own (11 and 13 are init_sso's
  // running and done tasks); a lane is the task's field, so this is a store the route reads, not markup injected into
  // the page.
  const lanes = { 11: "cookie", 13: "login" };
  for (const tasks of Object.values(queues)) {
    for (const task of tasks) {
      if (lanes[task.id]) task.lane = lanes[task.id];
      if (task.id === 11 || task.id === 13) task.waveId = "wave-flip";
      if (task.id === 21) task.waveId = "wave-proof";
    }
  }
  const waves = {
    version: 1,
    savedAt: new Date().toISOString(),
    byInitiative: {
      init_sso: [
        { id: "wave-proof", initiativeId: "init_sso", position: 1, title: "Prove the Okta callback through the VIP", entryGate: { check: "clean" }, exitGate: { check: "clean" }, template: null, auto: true },
        { id: "wave-flip", initiativeId: "init_sso", position: 2, title: "Flip the Menu login to SSO behind the toggle", entryGate: { check: "clean" }, exitGate: { check: "pr-open" }, template: null, auto: false },
        { id: "wave-retire", initiativeId: "init_sso", position: 3, title: "Retire the LDAP fallback and close the migration", entryGate: null, exitGate: null, template: "sefl-review-loop", auto: false },
      ],
    },
  };
  writeFileSync(path.join(state, "waves.json"), `${JSON.stringify(waves, null, 2)}\n`, "utf8");
  for (const [id, tasks] of Object.entries(queues)) {
    const dir = path.join(state, "assistants", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "queue.json"), `${JSON.stringify({ version: 1, nextId: 100, tasks }, null, 1)}\n`, "utf8");
  }
  return { initiatives: path.join(state, "initiatives.json"), assistants: path.join(state, "assistants.json") };
}

const commit = (where, message) => {
  git(where, ["add", "-A"]);
  git(where, ["commit", "-q", "-m", message]);
};

// Build the repositories and the three stores. `reset` removes a previous fixture at the same home first, so a
// second run cannot inherit a `missing` tree that has come back, or a worktree that is already registered.
export async function buildFixture({ home = defaultHome(), reset = true } = {}) {
  if (reset) rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  const repos = path.join(home, "repos");
  mkdirSync(repos, { recursive: true });
  const config = {
    host: "127.0.0.1",
    scanRoots: [repos],
    projects: PROJECTS.map((name) => ({ name, path: path.join(repos, name), remote: "origin", mainBranch: "main" })),
    refreshSeconds: 3,
    worktreeSeconds: 2,
    midSeconds: 8,
    dormantSeconds: 15,
    slowSeconds: 20,
    fetchSeconds: 3600,
    scanMode: "all",
    defaultCwd: path.join(repos, "oauth2-multi"),
    apiServer: { url: "http://127.0.0.1:9", key: "fixture" },
    assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
  };
  writeFileSync(path.join(home, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  for (const project of PROJECTS) {
    const repo = path.join(repos, project);
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(path.join(repo, "README.md"), `# ${project}\n\nA throwaway project for the initiatives fixture.\n`, "utf8");
    commit(repo, "seed the fixture project");
    for (const entry of TREES.filter((t) => t.project === project)) {
      const where = path.join(repo, ".worktrees", entry.name);
      git(repo, ["worktree", "add", "-q", "-b", entry.branch, where]);
      writeFileSync(path.join(where, `${entry.name}.txt`), `work for ${entry.name}\n`, "utf8");
      commit(where, `start ${entry.name}`);
    }
  }
  const files = writeState(home);
  return { home, repos, files, projects: PROJECTS, trees: treePaths(home) };
}

// Boot `server.js` from `root` with this fixture's home. No PANEL_CONFIG: WAG_HOME is the one authority, which is
// what keeps the reader's `~/.wag` out of the picture.
export async function startFixturePanel({ home = defaultHome(), root = ROOT, port = null, env = {} } = {}) {
  const chosen = port || (await freePort());
  // The port is the fixture's, never the panel default (7331, where the reader's own board lives). It is written into
  // the fixture's config before the boot, so a hand-run of `server.js` against this home answers on the same port.
  const configFile = path.join(home, "config.json");
  if (existsSync(configFile)) {
    try {
      const config = JSON.parse(readFileSync(configFile, "utf8"));
      config.port = chosen;
      config.host = "127.0.0.1";
      writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    } catch {
      /* an unreadable config is the boot's problem; it will say so with its own sentence */
    }
  }
  const out = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      WAG_HOME: home,
      HERMES_HOME: path.join(home, "hermes"),
      CLAUDE_CONFIG_DIR: path.join(home, "claude"),
      PANEL_PARENT_WATCH_STDIN: "1",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_ASKPASS: "echo",
      API_SERVER_KEY: "",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => out.push(d));
  child.stderr.on("data", (d) => out.push(d));
  let exited = null;
  child.on("exit", (code, signal) => {
    exited = { code, signal };
  });
  const base = `http://127.0.0.1:${chosen}`;
  const deadline = Date.now() + 25_000;
  for (;;) {
    if (exited) throw new Error(`fixture panel exited before it was ready (${JSON.stringify(exited)}):\n${out.join("")}`);
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`fixture panel did not answer /api/health within 25s:\n${out.join("")}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base,
    port: chosen,
    home,
    root,
    pid: child.pid,
    log: () => out.join(""),
    async stop() {
      if (!exited) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 8_000);
          timer.unref?.();
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          child.kill();
        });
        if (!exited) child.kill("SIGKILL");
      }
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    },
  };
}

export async function waitForFixtureRows(base, { timeout = 90_000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  for (;;) {
    try {
      const r = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        last = await r.json();
        const rows = (last.projects || []).flatMap((p) => (p.worktrees || []).map((w) => String(w.path).replace(/\\/g, "/").toLowerCase()));
        const have = TREES.map((t) => t.name).every((name) => rows.some((p) => p.endsWith(`/${name}`)));
        if (have) return last;
      }
    } catch {
      /* a scan can reset a socket mid-sweep; retry until the deadline */
    }
    if (Date.now() > deadline) {
      const seen = (last?.projects || []).map((p) => `${p.name}:${(p.worktrees || []).length}`).join(", ");
      throw new Error(`timed out waiting for the fixture rows; board read: ${seen || "none"}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Does the initiatives route see every seeded tree on a board row? This is the fixture's own health check: a tab
// screenshot taken before the scan has caught up draws dimmed "missing" rows and looks like a design defect.
export async function waitForInitiativesView(base, { timeout = 60_000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  for (;;) {
    try {
      const r = await fetch(`${base}/api/initiatives`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        last = await r.json();
        const trees = (last.initiatives || []).flatMap((i) => (i.projects || []).flatMap((p) => p.trees));
        const missing = trees.filter((t) => t.missing && !/retired-cert-probe/.test(t.path));
        // A branch is resolved a pass after the path arrives. A screenshot taken in between draws a tree row with no
        // branch chip - the long chip the redesign is measured on - so the wait covers it too.
        const branchless = trees.filter((t) => !t.missing && !String(t.branch || "").trim());
        if (last.initiatives?.length === 4 && !missing.length && !branchless.length) return last;
      }
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) {
      const missing = (last?.initiatives || []).flatMap((i) => (i.projects || []).flatMap((p) => p.trees)).filter((t) => t.missing).map((t) => t.path);
      throw new Error(`timed out waiting for the initiatives view; still missing: ${missing.join(", ") || "no initiatives"}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

export { existsSync };
