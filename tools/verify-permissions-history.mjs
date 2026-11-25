// The header's Permissions button, its popup and its durable history, proved against REAL approvals: a request is
// presented to the panel exactly as the Hermes approval-transport plugin presents one, answered through the panel's own
// POST /api/approvals/answer by pressing the choice in the popup, left to time out, and read back after a restart.
// HARNESS: LIVE GATE. `npm run verify:permissions-history`.
//
//   node tools/verify-permissions-history.mjs                  # this checkout
//   node tools/verify-permissions-history.mjs --keep           # leave the sandbox on disk
//   node tools/verify-permissions-history.mjs --out <dir>      # where the screenshots go
//
// THE BRIEF, and the section that proves each line:
//
//   1. A WAITING REQUEST RAISES THE BADGE. The request is POSTed to /api/approvals with the fields the plugin sends
//      (request_id, command, description, pattern_key, allowed_choices, timeout_seconds, surface, thread). /api/state
//      carries it in `approvals`, the page applies that list, and the header button draws "1" from it without the popup
//      ever being opened - and without a read of its own (emptying the page's map is what moves the number).
//   2. IT OPENS WITH ITS EXACT TEXT AND CHOICES. The popup row carries the command byte for byte (a <pre>), the
//      gateway's policy note, the run and the thread it belongs to, and one button per choice the HOST allowed - and
//      only those.
//   3. AN ANSWER RECORDS THE DECISION. Pressing "Allow once" in the POPUP posts /api/approvals/answer; the request
//      leaves the live queue, and the durable row says once / reader / when. A second POST for the same request is
//      refused (409) and the record keeps ONE decision with its original time.
//   4. A TIMEOUT RECORDS AN EXPIRY, NOT A DECISION. A request with a 1 s window is presented and never answered: the
//      store's row reads expired with no choice, stamped at the deadline, while the host's own fail-closed verdict
//      answers `deny` with `by: timeout` - the history must not borrow that word for a person.
//   5. THE HISTORY SURVIVES A RESTART. The panel is stopped and booted again on the same state folder; the route still
//      answers both rows with the same decision and the same expiry, because it re-reads the file.
//
// WHAT IS REAL HERE. The server is this checkout's server.js on its own port and its own state folder; the page is the
// one it serves; the approvals are presented through the panel's real POST /api/approvals and answered through its real
// POST /api/approvals/answer; the popup answer is a real press on a real button. Nothing fabricates page state.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, startPanel, waitFor } from "./panel-testkit.mjs";
import { loadPlaywright, withBrowser } from "./browser.mjs";

const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const keep = argv.includes("--keep");
const outDir = argOf("out", path.join(ROOT, "docs", "assets", "permissions-history"));
const dir = argOf("dir", path.join(os.tmpdir(), "wag-permissions-history-sandbox"));
mkdirSync(outDir, { recursive: true });
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

let checks = 0;
let failures = 0;
const ok = (label, cond, detail = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${label}${detail ? `: ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
};
const is = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}${JSON.stringify(got) === JSON.stringify(want) ? "" : ` want ${JSON.stringify(want)}`}`);
const section = (t) => console.log(`\n-- ${t}`);
const shot = (name) => path.join(outDir, name);

// ---- the fixture: one project, one worktree, one agent waiting on it --------------------------------------------
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=Gate", "-c", "user.email=gate@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const repos = path.join(dir, "repos");
const project = path.join(repos, "demo");
const worktree = path.join(project, ".worktrees", "wt-permissions");
mkdirSync(repos, { recursive: true });
mkdirSync(project, { recursive: true });
git(project, "init", "-q", "-b", "main");
writeFileSync(path.join(project, "README.md"), "the gate's project\n", "utf8");
git(project, "add", "-A");
git(project, "commit", "-q", "-m", "fixture: one commit");
git(project, "worktree", "add", "-q", "-b", "wt/permissions", worktree);

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const THREAD = "wt-permissions-thread";
const RUN = "run_gate_permissions";
const AGENT = "the permissions gate's agent";
// The job record the transport plugin's WTGUI_THREAD points at: the popup resolves the RUN and the TREE out of it, which
// is the whole reason the thread is echoed back. `status: running` keeps the card live.
const job = {
  id: "t1",
  thread: THREAD,
  turn: 1,
  origin: "worker",
  status: "running",
  startedAt: iso(now - 6 * 60_000),
  endedAt: null,
  lastActiveAt: iso(now - 60_000),
  prompt: "push the branch",
  finalMessage: "",
  cwd: worktree,
  ownerPath: worktree,
  worktreePath: worktree,
  worktree: "wt-permissions",
  branch: "wt/permissions",
  title: AGENT,
  runId: RUN,
  lines: [],
};
mkdirSync(path.join(dir, "logs"), { recursive: true });
writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ version: 3, savedAt: iso(now), jobs: [job] }, null, 1), "utf8");

// ---- HTTP against the panel's own routes -----------------------------------------------------------------------
const req = async (base, method, url, body) => {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { "Content-Type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text };
};

const EXACT = `git push origin wt/permissions --force-with-lease="refs/heads/wt/permissions:${"a".repeat(40)}"`;
const POLICY = "writes to a remote (policy: git-push, matched git push --force)";

let panel = await startPanel({ dir, keep: true, config: { remoteBranchPolicy: "local-only" } });
let base = panel.base;
const storeFile = path.join(dir, "logs", "permissions-history.json");

const present = (over = {}) =>
  req(base, "POST", "/api/approvals", {
    request_id: over.request_id,
    digest: "d".repeat(64),
    command: over.command,
    description: over.description ?? POLICY,
    pattern_key: over.pattern_key ?? "git-push",
    allowed_choices: over.allowed_choices ?? ["once", "session", "deny"],
    timeout_seconds: over.timeout_seconds ?? 600,
    surface: over.surface ?? "terminal",
    thread: over.thread ?? THREAD,
  });

// ---- 1. a waiting request raises the badge ----------------------------------------------------------------------
section("1. a waiting request raises the badge");
let r = await present({ request_id: "req-live-1", command: EXACT });
ok("the panel accepts the request the plugin posts", r.status === 202 && r.body?.ok === true, `HTTP ${r.status} ${r.text.slice(0, 120)}`);
let hist = await req(base, "GET", "/api/permissions/history");
is("the route counts exactly one request waiting", hist.body?.outstanding, 1);
const liveRow = (hist.body?.pending || [])[0] || {};
ok("the live request keeps the exact command", liveRow.command === EXACT, liveRow.command === EXACT ? "byte for byte" : JSON.stringify(liveRow.command));
is("the live request offers exactly the host's choices", liveRow.choices, ["once", "session", "deny"]);
is("it names the gateway run behind it", liveRow.runId, RUN);
is("it names the thread that is blocked", liveRow.thread, THREAD);
is("it carries the gateway's one-line policy note", liveRow.policy, POLICY);
// THE BADGE'S SOURCE. The brief names /api/state: the snapshot the board already polls carries the approval
// transport's live queue in `approvals`, and the header button counts THAT, not a request of its own. The snapshot
// text is served from the board's own cache and rebuilt on a short floor, so the read waits for the rebuild rather
// than sampling the text built before the request arrived.
await waitFor(
  async () => {
    const s = await req(base, "GET", "/api/state");
    return (s.body?.approvals || []).some((r) => r.id === "req-live-1");
  },
  { timeoutMs: 10_000, what: "/api/state carrying the waiting approval", silent: true },
);
const snap = await req(base, "GET", "/api/state");
is("the snapshot the board polls carries the waiting request", (snap.body?.approvals || []).map((r) => r.id), ["req-live-1"]);

const verdict = await withBrowser(
  async ({ page, pageErrors, consoleErrors }) => {
    await page.goto(`${base}/?gate=permissions`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#btn-permissions", { state: "visible", timeout: 30_000 });
    // The first snapshot lands after the shell paints, and the config line it writes is what can wrap the header to a
    // second row. Waiting for it keeps the screenshots honest: the popup is placed under the button as the page finally
    // draws it, not under where it stood for the first second.
    await page.waitForFunction(() => /project/i.test(document.getElementById("config-line")?.textContent || ""), null, { timeout: 30_000 });
    // The count is read on its own tick, so the badge is waited for rather than assumed.
    await page.waitForFunction(() => {
      const b = document.getElementById("permissions-badge");
      return b && !b.hidden && b.textContent.trim() === "1";
    }, null, { timeout: 20_000 });
    ok("the header button draws a badge of 1", true);
    // ...AND THE NUMBER IS THE SNAPSHOT'S OWN. The page applies /api/state's `approvals` as its first full snapshot
    // lands (a second or so after the shell paints), so the map is waited for and then emptied: that drops the count
    // to zero with no fetch, and putting the entry back restores it. A count that came from a second read of the route
    // would not move.
    await page.waitForFunction(() => state.approvalsSeen.count >= 0 && state.approvals.size > 0, null, { timeout: 15_000 });
    const fromState = await page.evaluate(() => {
      const saved = [...state.approvals.values()];
      const before = permissionsPendingCount();
      state.approvals.clear();
      const emptied = permissionsPendingCount();
      for (const r of saved) state.approvals.set(r.id, r);
      return { ids: saved.map((r) => r.id), before, emptied, restored: permissionsPendingCount() };
    });
    is("the page applied the request from /api/state", fromState.ids, ["req-live-1"]);
    is("the badge counts that map, not a request of its own", [fromState.before, fromState.emptied, fromState.restored], [1, 0, 1]);
    await page.screenshot({ path: shot("1-badge.png"), clip: { x: 0, y: 0, width: 1440, height: 160 } });

    // ---- 2. the popup opens with the exact text and choices ----
    section("2. the popup opens with the exact text and choices");
    await page.click("#btn-permissions");
    await page.waitForSelector("#permissions-pop:not([hidden]) .ph-row.is-open", { timeout: 10_000 });
    const open = await page.evaluate(() => {
      const row = document.querySelector("#permissions-pop .ph-row.is-open");
      return {
        command: row.querySelector("pre.ph-cmd")?.textContent ?? "",
        policy: row.querySelector(".ph-policy")?.textContent ?? "",
        choices: [...row.querySelectorAll("button[data-ph-choice]")].map((b) => b.dataset.phChoice),
        labels: [...row.querySelectorAll("button[data-ph-choice]")].map((b) => b.textContent.trim()),
        meta: row.querySelector(".ph-meta")?.textContent ?? "",
        mark: row.querySelector(".ph-mark")?.textContent ?? "",
      };
    });
    ok("the popup row shows the command byte for byte", open.command === EXACT, open.command === EXACT ? "exact" : JSON.stringify(open.command));
    ok("the popup row shows the gateway's policy note", open.policy.includes("policy: git-push"), JSON.stringify(open.policy));
    is("one button per allowed choice, in the host's order", open.choices, ["once", "session", "deny"]);
    is("each button carries the panel's own word for it", open.labels, ["Allow once", "Allow for session", "Deny"]);
    ok("the row names the run, the thread and the tree", open.meta.includes(RUN) && open.meta.includes(THREAD) && open.meta.includes("wt/permissions"), open.meta.replace(/\s+/g, " ").trim().slice(0, 160));
    ok("the row says it is waiting on a person", /waiting on you/i.test(open.mark), open.mark.trim());
    await page.screenshot({ path: shot("2-popup-waiting.png") });

    // ---- 3. an answer records the decision, from a real press ----
    section("3. an answer records the decision");
    await page.click('#permissions-pop button[data-ph-choice="once"]');
    // The row flips to the decision when the panel's own re-read lands.
    await page.waitForSelector("#permissions-pop .ph-row.is-answered", { timeout: 10_000 });
    await page.waitForFunction(() => {
      const b = document.getElementById("permissions-badge");
      return !b || b.hidden;
    }, null, { timeout: 20_000 });
    ok("the badge clears once the request is answered", true);
    const answered = await page.evaluate(() => {
      const row = document.querySelector("#permissions-pop .ph-row.is-answered");
      return { answer: row?.querySelector(".ph-answer")?.textContent ?? "", mark: row?.querySelector(".ph-mark")?.textContent ?? "" };
    });
    ok("the answered row shows the choice that was pressed", /Allow once/.test(answered.answer), answered.answer.trim());
    await page.screenshot({ path: shot("3-answered.png") });

    const pageProblems = [...pageErrors, ...consoleErrors].filter((e) => !/favicon|net::ERR_ABORTED/i.test(String(e?.message || e)));
    ok("the page threw nothing and logged no error", pageProblems.length === 0, pageProblems.map((e) => e.message).join(" | ").slice(0, 300));
    return failures;
  },
  { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
);
void verdict;

hist = await req(base, "GET", "/api/permissions/history");
const answeredEntry = (hist.body?.entries || []).find((e) => e.requestId === "req-live-1") || {};
is("the live queue is empty after the press", hist.body?.outstanding, 0);
is("the decision is on the durable record", [answeredEntry.status, answeredEntry.choice, answeredEntry.answeredBy], ["answered", "once", "reader"]);
ok("the decision is stamped with when it was made", Boolean(answeredEntry.answeredAt), answeredEntry.answeredAt || "");
ok("the record keeps the exact request it answered", answeredEntry.command === EXACT);
const answeredAt = answeredEntry.answeredAt;

// A SECOND PRESS CANNOT DOUBLE-ANSWER. The panel refuses it (the request left its pending map when the first was
// accepted), and the record is untouched: one decision, its original time.
const again = await req(base, "POST", "/api/approvals/answer", { id: "req-live-1", choice: "deny" });
ok("a second answer is refused by the panel", again.status === 409, `HTTP ${again.status} ${String(again.body?.error || "").slice(0, 80)}`);
hist = await req(base, "GET", "/api/permissions/history");
const stillOne = (hist.body?.entries || []).find((e) => e.requestId === "req-live-1") || {};
is("the record still holds exactly one decision", [stillOne.choice, stillOne.answeredAt], ["once", answeredAt]);
is("no second decision was written for the request", (hist.body?.entries || []).filter((e) => e.requestId === "req-live-1").length, 1);

// ---- 4. a timeout records an expiry, not a decision -------------------------------------------------------------
section("4. a timeout records an expiry, not a decision");
const t = await present({ request_id: "req-timeout-1", command: "rm -rf build/ && make clean", description: "destructive command (policy: rm)", allowed_choices: ["once", "deny"], timeout_seconds: 1 });
ok("the panel accepts the short-window request", t.status === 202, `HTTP ${t.status}`);
// The panel's deadline sits inside the host's window (lib/approvals.js), so a 1 s window is already closed.
hist = await req(base, "GET", "/api/permissions/history");
const expiredRow = (hist.body?.entries || []).find((e) => e.requestId === "req-timeout-1") || {};
is("nobody answered it", hist.body?.outstanding, 0);
is("the record reads expired, not answered", expiredRow.status, "expired");
is("the expiry carries no choice at all", [expiredRow.choice, expiredRow.answeredBy, expiredRow.answeredAt], ["", "", null]);
is("the expiry says why", expiredRow.closedWhy, "timed out");
ok("the expiry is stamped at the deadline the host gave", Boolean(expiredRow.closedAt) && Date.parse(expiredRow.closedAt) <= Date.now(), expiredRow.closedAt || "");
// The host's own fail-closed verdict, for contrast: the sweep has to send `deny` to the waiting caller, by timeout.
await waitFor(
  async () => {
    const s = await req(base, "GET", `/api/approvals/req-timeout-1`);
    return s.body?.status === "answered";
  },
  { timeoutMs: 12_000, what: "the approval sweep", silent: true },
);
const hostWord = await req(base, "GET", "/api/approvals/req-timeout-1");
is("the host's fail-closed verdict is the deny the sweep had to send", [hostWord.body?.status, hostWord.body?.choice], ["answered", "deny"]);
hist = await req(base, "GET", "/api/permissions/history");
const keptExpired = (hist.body?.entries || []).find((e) => e.requestId === "req-timeout-1") || {};
is("the history still says expired, and never borrows the host's deny", keptExpired.status, "expired");
is("the history's expired row still has no choice", keptExpired.choice, "");

// The file on disk is the panel's state folder, not a checkout.
ok("the record lives in the panel's state folder", storeFile.includes(`${path.sep}logs${path.sep}permissions-history.json`), storeFile);
const onDisk = JSON.parse(readFileSync(storeFile, "utf8"));
is("the file carries both rows", onDisk.entries.length, 2);
ok("the file carries the decision and the expiry", onDisk.entries.some((e) => e.status === "answered" && e.choice === "once") && onDisk.entries.some((e) => e.status === "expired" && !e.choice));

// ---- 5. the history survives a restart --------------------------------------------------------------------------
section("5. the history survives a restart");
await panel.stop();
panel = await startPanel({ dir, keep: true, reuseConfig: true });
base = panel.base;
hist = await req(base, "GET", "/api/permissions/history");
const after = hist.body?.entries || [];
const afterAnswered = after.find((e) => e.requestId === "req-live-1") || {};
const afterExpired = after.find((e) => e.requestId === "req-timeout-1") || {};
is("the restarted panel still answers both rows", after.length, 2);
is("the decision survived with its choice, who and when", [afterAnswered.status, afterAnswered.choice, afterAnswered.answeredBy, afterAnswered.answeredAt], ["answered", "once", "reader", answeredAt]);
is("the expiry survived as an expiry", [afterExpired.status, afterExpired.closedWhy, afterExpired.choice], ["expired", "timed out", ""]);
ok("the restarted panel keeps the exact request text", afterAnswered.command === EXACT && afterExpired.command === "rm -rf build/ && make clean");
is("nothing is waiting after the restart", hist.body?.outstanding, 0);

await panel.stop();

console.log(`\n${failures ? "FAILED" : "PASSED"}  ${checks - failures}/${checks} checks`);
if (keep) console.log(`sandbox kept at ${dir}`);
process.exit(failures ? 1 : 0);
