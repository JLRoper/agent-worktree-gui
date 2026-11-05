// "May this remote be pushed without asking me first?" — the per-project switch, and the four gates it ships with.
//
// The panel already answers "may a branch exist on a remote at all" (config.json `remoteBranchPolicy`, per project
// over global, lib/remote-writes.js `policyForProject`). This is the narrower question layered on top: for THIS
// remote, is a push allowed to go through without parking on the reader's permission box? Shipped OFF, so an
// install that never names the key behaves exactly as it did.
//
// What this pins, each one a way the switch can look right and be wrong:
//
//   1. a project that names no value is OFF — absence is not permission, and the resolved source says `default`;
//   2. a project's own value overrides the global one, in BOTH directions: true over a false/absent global, and
//      false over a true global. One direction alone would pass a resolver that returns the global;
//   3. `deny` still wins: a project whose policy refuses remote writes outright cannot open the door with the switch,
//      even after the reader stores `true` on it;
//   4. `POST /api/settings/remote-push` round-trips one project's toggle into config.json and back out through the
//      settings the API serves, and GET /api/remote-write/allow-push — the assistant-readable endpoint — reads the
//      resolved value for a checkout;
//   5. the Settings tab's REMOTES section draws one row per configured project, checked only where the resolved value
//      is on, with the help line that says an unchecked remote means the assistant asks first.
//
// The route half boots the real server.js (tools/panel-testkit.mjs); the settings-row half slices the page's own
// region so the claim is about the function the browser runs, not about its source text.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as remoteWrites from "../lib/remote-writes.js";
import { configureRepo, git as runGit, post, startPanel } from "../tools/panel-testkit.mjs";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const slash = (p) => String(p || "").replace(/\\/g, "/");

// Three repositories, deliberately different:
//   alpha — names no switch at all (the shipped default);
//   beta  — carries `allowPushWithoutAsking: true` while the global says nothing;
//   gamma — carries `true` too, but its policy is `deny`, which wins.
const NAMES = ["alpha", "beta", "gamma"];

async function makeBoard() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-allow-push-"));
  const repos = path.join(dir, "repos");
  mkdirSync(repos, { recursive: true });
  const paths = {};
  for (const name of NAMES) {
    const repo = path.join(repos, name);
    mkdirSync(repo, { recursive: true });
    runGit(repo, ["init", "-q", "-b", "main"]);
    configureRepo(repo);
    runGit(repo, ["commit", "-q", "--allow-empty", "-m", "first"]);
    paths[name] = slash(repo);
  }
  return { dir, repos, paths };
}

const configFor = (board) => ({
  scanRoots: [slash(board.repos)],
  // No top-level allowPushWithoutAsking: the shipped file has none, and the default must not need a written record.
  projects: [
    { name: "alpha", path: board.paths.alpha, mainBranch: "main", remote: "origin" },
    { name: "beta", path: board.paths.beta, mainBranch: "main", remote: "origin", allowPushWithoutAsking: true },
    { name: "gamma", path: board.paths.gamma, mainBranch: "main", remote: "origin", allowPushWithoutAsking: true, remoteBranchPolicy: "deny" },
  ],
  assistant: { enabled: false },
  worktreeSeconds: 4,
  midSeconds: 4,
  dormantSeconds: 4,
  slowSeconds: 4,
});

const allowPush = async (base, checkout) => {
  const r = await fetch(`${base}/api/remote-write/allow-push?path=${encodeURIComponent(checkout)}`);
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
};

test("the switch is OFF for a project that names no value, and says the default is why", async (t) => {
  const board = await makeBoard();
  let panel;
  try {
    panel = await startPanel({ dir: board.dir, keep: true, config: configFor(board) });
    const got = await allowPush(panel.base, board.paths.alpha);
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.equal(got.body.project, "alpha");
    assert.equal(got.body.allowPushWithoutAsking, false, "absence is not permission");
    assert.equal(got.body.source, "default", "the resolver says the value came from the shipped default");
    assert.equal(got.body.denied, false);
    // The settings the page draws read the same answer, so the checkbox is not off by one server and on by another.
    const cfg = await (await fetch(`${panel.base}/api/config`)).json();
    assert.equal(cfg.allowPushWithoutAskingProjects?.alpha, false);
    assert.equal(cfg.allowPushWithoutAsking, false, "the global is off too, and not written into the file");
    assert.equal("allowPushWithoutAsking" in JSON.parse(readFileSync(path.join(board.dir, "config.json"), "utf8")), false);
  } finally {
    if (panel) await panel.stop();
    await rm(board.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("a project's value overrides the global, in both directions", async (t) => {
  // The pure resolver first: it is the one function both the settings API and the assistant endpoint call, and a
  // version that returns the global would still pass a panel where only `true` is tested.
  const resolve = remoteWrites.allowPushWithoutAskingFor;
  assert.equal(typeof resolve, "function", "lib/remote-writes.js exports the resolver");
  assert.deepEqual(
    { enabled: resolve({ allowPushWithoutAsking: true }, { allowPushWithoutAsking: false }).enabled, source: resolve({ allowPushWithoutAsking: true }, { allowPushWithoutAsking: false }).source },
    { enabled: true, source: "project" },
  );
  assert.deepEqual(
    { enabled: resolve({ allowPushWithoutAsking: false }, { allowPushWithoutAsking: true }).enabled, source: resolve({ allowPushWithoutAsking: false }, { allowPushWithoutAsking: true }).source },
    { enabled: false, source: "project" },
    "a project that says false beats a global that says true",
  );
  assert.deepEqual(
    { enabled: resolve({}, { allowPushWithoutAsking: true }).enabled, source: resolve({}, { allowPushWithoutAsking: true }).source },
    { enabled: true, source: "global" },
    "no project value inherits the global one",
  );

  const board = await makeBoard();
  let panel;
  try {
    panel = await startPanel({ dir: board.dir, keep: true, config: configFor(board) });
    const got = await allowPush(panel.base, board.paths.beta);
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.equal(got.body.project, "beta");
    assert.equal(got.body.allowPushWithoutAsking, true, "the project's own true wins");
    assert.equal(got.body.source, "project");
    assert.equal(got.body.ask, false, "an enabled remote is one the assistant need not ask about");
    assert.equal(got.body.remote, "origin");
    const cfg = await (await fetch(`${panel.base}/api/config`)).json();
    assert.equal(cfg.allowPushWithoutAskingProjects?.beta, true);
    assert.equal(cfg.allowPushWithoutAskingProjects?.alpha, false, "one project being on does not turn the others on");
  } finally {
    if (panel) await panel.stop();
    await rm(board.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("deny still wins over the switch — reading it, and after the reader stores true on it", async (t) => {
  const board = await makeBoard();
  let panel;
  try {
    panel = await startPanel({ dir: board.dir, keep: true, config: configFor(board) });
    const got = await allowPush(panel.base, board.paths.gamma);
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.equal(got.body.policy, "deny");
    assert.equal(got.body.allowPushWithoutAsking, false, "a deny policy is not opened by the switch");
    assert.equal(got.body.denied, true, "and the answer says the policy is what refused it");
    assert.equal(got.body.ask, false, "deny does not even ask");

    // The decision the guard's request route makes agrees: the switch handed in is ignored under deny.
    const gate = new remoteWrites.RemoteWrites({ getPolicy: () => "local-only" });
    try {
      const decision = gate.decision(board.paths.gamma, "deny", { allowPushWithoutAsking: true });
      assert.equal(decision.allowed, false);
      assert.equal(decision.ask, false);
    } finally {
      gate.stop();
    }

    // Storing the switch ON cannot beat it either: the file may say true, the resolved answer stays false.
    const saved = await post(panel.base, "/api/settings/remote-push", { body: { project: "gamma", allow: true } });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(JSON.parse(readFileSync(path.join(board.dir, "config.json"), "utf8")).projects.find((p) => p.name === "gamma").allowPushWithoutAsking, true, "the file records what the reader asked for");
    const after = await allowPush(panel.base, board.paths.gamma);
    assert.equal(after.body.allowPushWithoutAsking, false, "and the resolved answer still refuses");
    assert.equal(after.body.denied, true);
    assert.equal(saved.json.settings.allowPushWithoutAskingProjects.gamma, false);
  } finally {
    if (panel) await panel.stop();
    await rm(board.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("POST /api/settings/remote-push round-trips one project's toggle through config.json and the settings API", async (t) => {
  const board = await makeBoard();
  let panel;
  try {
    panel = await startPanel({ dir: board.dir, keep: true, config: configFor(board) });
    const on = await post(panel.base, "/api/settings/remote-push", { body: { project: "alpha", allow: true } });
    assert.equal(on.status, 200, on.text);
    assert.equal(on.json.ok, true);
    assert.equal(on.json.project, "alpha");
    assert.equal(on.json.allow, true);
    // What is in FORCE (the answer + the settings /api/config serves) and what was WRITTEN are two reads.
    assert.equal(on.json.settings.allowPushWithoutAskingProjects.alpha, true);
    const live = await (await fetch(`${panel.base}/api/config`)).json();
    assert.equal(live.allowPushWithoutAskingProjects.alpha, true);
    const written = JSON.parse(readFileSync(path.join(board.dir, "config.json"), "utf8"));
    assert.equal(written.projects.find((p) => p.name === "alpha").allowPushWithoutAsking, true);
    const resolved = await allowPush(panel.base, board.paths.alpha);
    assert.equal(resolved.body.allowPushWithoutAsking, true, "the assistant's endpoint reads the saved value");

    // …and off again, so the toggle is a toggle and not a one-way door.
    const off = await post(panel.base, "/api/settings/remote-push", { body: { project: "alpha", allow: false } });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.json.settings.allowPushWithoutAskingProjects.alpha, false);
    assert.equal(JSON.parse(readFileSync(path.join(board.dir, "config.json"), "utf8")).projects.find((p) => p.name === "alpha").allowPushWithoutAsking, false);
    assert.equal((await allowPush(panel.base, board.paths.alpha)).body.allowPushWithoutAsking, false);

    // A route that guesses is worse than one that refuses: an unknown project is a 404, and a non-boolean `allow` is a
    // 400 rather than a silent "off".
    const unknown = await post(panel.base, "/api/settings/remote-push", { body: { project: "nope", allow: true } });
    assert.equal(unknown.status, 404, unknown.text);
    const vague = await post(panel.base, "/api/settings/remote-push", { body: { project: "alpha", allow: "yes" } });
    assert.equal(vague.status, 400, vague.text);
  } finally {
    if (panel) await panel.stop();
    await rm(board.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("the worker's first line and the LANDING paragraph follow the switch — and deny still wins", async () => {
  // The brief is the other place a worker learns what a push will do: if the paragraph said "a push will park and then
  // fail" while the switch lets it through, the worker would report instead of pushing. Loaded inside the test so the
  // Hermes home this module reads is the throwaway one, exactly as test/brief-follows-the-policy.test.js does it.
  process.env.HERMES_HOME = await mkdtemp(path.join(os.tmpdir(), "wtgui-allow-push-home-"));
  process.env.API_SERVER_KEY = "";
  const { remoteWriteLine } = await import("../lib/jobs.js");
  const { branchLandingLine } = await import("../lib/branch-policy.js");
  const base = { cwd: "C:/tree", remote: "origin" };

  assert.match(remoteWriteLine({ ...base, branchPolicy: "local-only", allowPushWithoutAsking: true }), /ALLOWED WITHOUT ASKING/);
  assert.match(remoteWriteLine({ ...base, branchPolicy: "local-only" }), /^LOCAL-ONLY/, "the sentence off the switch is the one this panel always gave");
  assert.match(remoteWriteLine({ ...base, branchPolicy: "deny", allowPushWithoutAsking: true }), /^NO REMOTE WRITES/, "deny wins in the brief too");

  const landing = (o) => branchLandingLine({ parent: "main", branch: "wtgui/x", remote: "origin", cwd: "C:/tree", ...o });
  assert.match(landing({ policy: "local-only", allowPushWithoutAsking: true }), /switch is on/);
  assert.match(landing({ policy: "local-only" }), /permission box/);
  assert.match(landing({ policy: "allow", allowPushWithoutAsking: true }), /Remote writes are allowed for this project/, "an allow policy keeps its own wording");
  assert.match(landing({ policy: "deny", allowPushWithoutAsking: true }), /refuses a push outright/, "deny wins in the LANDING paragraph too");
});

test("the Settings REMOTES section draws every project, checked only where the switch is on, and carries the help line", () => {
  const begin = src.indexOf("// ---- remotes: allow push without asking");
  assert.ok(begin >= 0, "public/app.js carries the remotes region marker");
  const end = src.indexOf("// ---- end remotes", begin);
  assert.ok(end > begin, "and its end marker");
  const region = src.slice(src.indexOf("\n", begin) + 1, end);

  const holder = { innerHTML: "" };
  const preview = { textContent: "", classList: { add() {}, remove() {}, toggle() {} } };
  const $ = (id) => (id === "remote-switch-rows" ? holder : id === "remote-switch-preview" ? preview : null);
  const state = {
    projects: new Map([
      ["alpha", { name: "alpha", path: "C:/repos/alpha", remote: "origin" }],
      ["beta", { name: "beta", path: "C:/repos/beta", remote: "upstream" }],
      ["gamma", { name: "gamma", path: "C:/repos/gamma", remote: "origin" }],
    ]),
    settings: { allowPushWithoutAskingProjects: { alpha: false, beta: true, gamma: false } },
  };
  const page = new Function("state", "$", "esc", "apiFetch", "showBanner", `${region}\nreturn { paintRemoteSwitches, remoteSwitchRows, saveRemoteSwitch };`)(
    state,
    $,
    (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    async () => ({ ok: true, json: async () => ({}) }),
    () => {},
  );

  assert.deepEqual(page.remoteSwitchRows().map((r) => r.name), ["alpha", "beta", "gamma"], "one row per configured project, by name");
  page.paintRemoteSwitches();
  const html = holder.innerHTML;
  assert.equal((html.match(/data-remote-allow=/g) || []).length, 3, "every project has a switch");
  assert.match(html, /data-remote-allow="alpha"[^>]*>/, "alpha has a switch");
  assert.doesNotMatch(html, /data-remote-allow="alpha" checked/, "alpha is unchecked");
  assert.match(html, /data-remote-allow="beta" checked/, "beta is checked");
  assert.doesNotMatch(html, /data-remote-allow="gamma" checked/, "gamma is unchecked");
  // The row answers all three facts the brief names: name, path and remote.
  assert.match(html, /C:\/repos\/alpha/);
  assert.match(html, /origin/);
  assert.match(html, /C:\/repos\/beta/);
  assert.match(html, /upstream/);
  // The help line: an unchecked remote means the assistant asks first, and wtgui/* is never pushed by the switch.
  assert.match(preview.textContent, /clarify/i);
  assert.match(preview.textContent, /wtgui\/\*/);
  assert.match(preview.textContent, /1\/3 on/, "the line counts what is on, so a reader can see the shipped state");
});
