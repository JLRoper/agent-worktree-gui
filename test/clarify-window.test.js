// THE CARD DRAWS THE WINDOW THE GATEWAY WILL HONOUR, OR IT DRAWS NOTHING.
//
// The panel used to answer this question with its own constant: `clarifyWindowSeconds()` read 3600 s when
// `config.yaml` named neither timeout, and drew an hour-long countdown. The gateway was waiting 90 s
// (`tools/clarify_gateway.resolve_clarify_timeout` -> `agent.clarify_timeout` -> the 90 that
// `hermes_cli/config_defaults.py` ships), and six cards on the 2026-11-21 board closed at 89 to 93 s under a clock
// that still said ~59m. The four properties below are the contract now:
//
//   1. the resolution is the gateway's own order - `clarify.timeout`, else `agent.clarify_timeout`, else the shipped
//      default - and the panel's fallback constant equals that shipped default;
//   2. an absent pair of keys means 90 s, never an hour;
//   3. the shipped default is READ from the gateway's own defaults file when that tree is on this host, so a gateway
//      update cannot leave the card promising a window the gateway does not enforce;
//   4. the deadline the panel writes (and the card counts down) is the number the gateway enforces, for the same
//      config - proved against the gateway's own Python resolver, not against a comment.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CLARIFY_TIMEOUT_DEFAULT,
  clarifyDefaultSeconds,
  clarifyWindowSeconds,
} from "../lib/hermes-config.js";
import { Jobs } from "../lib/jobs.js";
import { hermesHome } from "../lib/hermes-runtime.js";

const quiet = () => {};

// A HERMES_HOME of its own, holding just the config text a case names. `gatewayDefault` writes a stand-in
// `hermes_cli/config_defaults.py` so the "read it where it lives" path can be proved without the real install.
function homeWith(t, { config = null, gatewayDefault = null } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wag-clarify-window-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (config !== null) writeFileSync(path.join(dir, "config.yaml"), config, "utf8");
  if (gatewayDefault !== null) {
    const defaults = path.join(dir, "hermes-agent", "hermes_cli");
    mkdirSync(defaults, { recursive: true });
    writeFileSync(path.join(defaults, "config_defaults.py"), `AGENT = {\n    "clarify_timeout": ${gatewayDefault},\n}\n`, "utf8");
  }
  return dir;
}

// ---- 1 + 2. the order, and the absent case ---------------------------------------------------------------
test("a config with no clarify key at all resolves to the gateway's 90, not an hour", (t) => {
  const home = homeWith(t, { config: "port: 7331\n" });
  const win = clarifyWindowSeconds({ home });
  assert.equal(win.seconds, 90, "the gateway's shipped agent.clarify_timeout, never the panel's old 3600");
  assert.equal(win.fromFile, false);
  assert.equal(win.unlimited, false, "a default is a real window: the card draws it and dies at it");
  assert.match(win.source, /default/, "the answer says it came from the default, not from a line in the file");
  assert.equal(win.defaultSeconds, CLARIFY_TIMEOUT_DEFAULT);
});

test("agent.clarify_timeout is read when clarify.timeout is absent, and clarify.timeout wins when both are", (t) => {
  const byAgent = clarifyWindowSeconds({ home: homeWith(t, { config: "agent:\n  clarify_timeout: 600\n" }) });
  assert.equal(byAgent.seconds, 600);
  assert.equal(byAgent.source, "agent.clarify_timeout");
  assert.equal(byAgent.fromFile, true);

  const both = clarifyWindowSeconds({
    home: homeWith(t, { config: "clarify:\n  timeout: 540\nagent:\n  clarify_timeout: 600\n" }),
  });
  assert.equal(both.seconds, 540, "clarify.timeout is the gateway's first branch, so it is the panel's first too");
  assert.equal(both.source, "clarify.timeout");
});

test("0 or a negative is the gateway waiting indefinitely: no countdown is drawn", (t) => {
  const zero = clarifyWindowSeconds({ home: homeWith(t, { config: "clarify:\n  timeout: 0\n" }) });
  assert.equal(zero.unlimited, true);
  assert.equal(zero.seconds, 0);
  const minus = clarifyWindowSeconds({ home: homeWith(t, { config: "agent:\n  clarify_timeout: -5\n" }) });
  assert.equal(minus.unlimited, true);
  assert.equal(minus.seconds, 0, "a countdown never counts up from a negative");
});

test("a value the resolver cannot read is the resolver's own except branch: the default", (t) => {
  const win = clarifyWindowSeconds({ home: homeWith(t, { config: "clarify:\n  timeout: bananas\nagent:\n  clarify_timeout: 600\n" }) });
  assert.equal(win.seconds, 90, "int('bananas') raises in the gateway, and its except answers 90 - not the next key");
  assert.equal(win.fromFile, false);
  assert.match(win.source, /cannot read/);
});

test("a key written as YAML null is not written: the next key answers, as the resolver reads it", (t) => {
  const nulled = clarifyWindowSeconds({ home: homeWith(t, { config: "clarify:\n  timeout: null\nagent:\n  clarify_timeout: 600\n" }) });
  assert.equal(nulled.seconds, 600, "None in the gateway's dict moves the resolver on to agent.clarify_timeout");
  assert.equal(nulled.source, "agent.clarify_timeout");
  const tilde = clarifyWindowSeconds({ home: homeWith(t, { config: "clarify:\n  timeout: ~\nagent:\n  clarify_timeout: 600\n" }) });
  assert.equal(tilde.seconds, 600, "a tilde is YAML's other null spelling");
});

test("a YAML float is truncated toward zero, the way the gateway's int() truncates it", (t) => {
  const win = clarifyWindowSeconds({ home: homeWith(t, { config: "clarify:\n  timeout: 300.5\n" }) });
  assert.equal(win.seconds, 300, "int(300.5) is 300 in the gateway, so the card counts down 300");
  assert.equal(win.fromFile, true);
});

// ---- 3. the shipped default, read where the gateway keeps it ---------------------------------------------
test("the shipped default is read from the gateway's own defaults file when it is there", (t) => {
  const home = homeWith(t, { gatewayDefault: 45 });
  const win = clarifyWindowSeconds({ home });
  assert.equal(win.seconds, 45, "the panel follows the gateway's shipped default rather than asserting one");
  assert.equal(win.defaultFrom, "config_defaults.py");
  assert.equal(win.fromFile, false);
});

test("the panel's fallback constant IS the default this host's gateway ships", (t) => {
  const file = path.join(hermesHome(), "hermes-agent", "hermes_cli", "config_defaults.py");
  if (!existsSync(file)) {
    t.skip("no gateway checkout under HERMES_HOME on this host");
    return;
  }
  const read = clarifyDefaultSeconds({ home: hermesHome() });
  assert.equal(read.from, "config_defaults.py", "the real gateway tree answers, so this is not the constant agreeing with itself");
  assert.equal(
    CLARIFY_TIMEOUT_DEFAULT,
    read.seconds,
    `CLARIFY_TIMEOUT_DEFAULT drifted from the gateway's shipped agent.clarify_timeout (${read.seconds} in ${file})`,
  );
});

// ---- 4. the drawn deadline is the enforced one ------------------------------------------------------------
// Run the gateway's OWN resolver on the same values. The panel's reader is a JS re-implementation, and the only
// honest proof that the two agree is the Python function answering beside it - a comment cannot drift into a test.
function gatewayResolve(values) {
  const root = path.join(hermesHome(), "hermes-agent");
  if (!existsSync(path.join(root, "tools", "clarify_gateway.py"))) return null;
  const py = ["python", "python3"].map((exe) => ({ exe, ...spawnSync(exe, ["--version"], { encoding: "utf8" }) })).find((r) => !r.error);
  if (!py) return null;
  const script = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(root)})`,
    "from tools.clarify_gateway import resolve_clarify_timeout",
    "print(resolve_clarify_timeout(json.loads(sys.argv[1])))",
  ].join("\n");
  const out = spawnSync(py.exe, ["-c", script, JSON.stringify(values)], { encoding: "utf8" });
  if (out.status !== 0) return null;
  const n = Number.parseInt(String(out.stdout).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

test("both sides agree at absent, at 600, at a float and when both keys are written", (t) => {
  const absent = gatewayResolve({});
  const byAgent = gatewayResolve({ agent: { clarify_timeout: 600 } });
  const both = gatewayResolve({ clarify: { timeout: 540 }, agent: { clarify_timeout: 600 } });
  const float = gatewayResolve({ clarify: { timeout: 300.5 } });
  const nulled = gatewayResolve({ clarify: { timeout: null }, agent: { clarify_timeout: 600 } });
  if (absent === null || byAgent === null || both === null || float === null || nulled === null) {
    t.skip("the gateway's Python resolver is not runnable on this host");
    return;
  }
  const panelAbsent = clarifyWindowSeconds({ home: homeWith(t, { config: "port: 7331\n" }) }).seconds;
  const panelByAgent = clarifyWindowSeconds({ home: homeWith(t, { config: "agent:\n  clarify_timeout: 600\n" }) }).seconds;
  const panelBoth = clarifyWindowSeconds({ home: homeWith(t, { config: "clarify:\n  timeout: 540\nagent:\n  clarify_timeout: 600\n" }) }).seconds;
  const panelFloat = clarifyWindowSeconds({ home: homeWith(t, { config: "clarify:\n  timeout: 300.5\n" }) }).seconds;
  const panelNulled = clarifyWindowSeconds({ home: homeWith(t, { config: "clarify:\n  timeout: null\nagent:\n  clarify_timeout: 600\n" }) }).seconds;
  assert.deepEqual(
    { absent: panelAbsent, byAgent: panelByAgent, both: panelBoth, float: panelFloat, nulled: panelNulled },
    { absent, byAgent, both, float, nulled },
    "the panel's resolution and tools/clarify_gateway.resolve_clarify_timeout answer the same numbers",
  );
});

// ---- the record the card draws from -----------------------------------------------------------------------
// `Jobs` is what turns a clarify.request into the card's numbers, so the proof belongs here too: the deadline is
// `at + seconds`, and no path through this file can invent a window of its own.
function jobsWith(home) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wag-clarify-jobs-"));
  return {
    jobs: new Jobs({
      config: { jobsFile: path.join(dir, "jobs.json"), clarifyHistoryFile: path.join(dir, "clarify-history.json") },
      onLog: quiet,
      clarifyWindow: () => clarifyWindowSeconds({ home }),
    }),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const row = (id) => ({ id, runId: `run-${id}`, thread: `thread-${id}`, status: "running", startedAt: new Date().toISOString(), endedAt: null, lines: [], title: id, question: null });

test("an API run's question (no timeout_s) gets the gateway's window, and its deadline is that many seconds out", (t) => {
  const { jobs, done } = jobsWith(homeWith(t, { config: "port: 7331\n" }));
  try {
    const j = row("job-window");
    jobs.jobs.set(j.id, j);
    jobs.consume(j, { event: "clarify.request", prompt_id: "prompt-window", question: "which side first?", choices: ["a", "b"] });
    assert.equal(j.question.timeoutSeconds, 90, "the card counts down 90 s, the window the gateway is waiting");
    const asked = Date.parse(j.question.at);
    assert.equal(j.question.deadline - asked, 90_000, "the drawn deadline is the enforced window, measured from the ask");
    assert.match(j.question.windowFrom, /gateway's window/, "the record says where the number came from");
  } finally {
    done();
  }
});

test("a configured 600 moves the deadline, and the gateway's own timeout_s still wins over the config", (t) => {
  const home = homeWith(t, { config: "agent:\n  clarify_timeout: 600\n" });
  const first = jobsWith(home);
  try {
    const j = row("job-600");
    first.jobs.jobs.set(j.id, j);
    first.jobs.consume(j, { event: "clarify.request", prompt_id: "p600", question: "q", choices: ["a"] });
    assert.equal(j.question.timeoutSeconds, 600);
    assert.equal(j.question.deadline - Date.parse(j.question.at), 600_000);
  } finally {
    first.done();
  }
  const second = jobsWith(home);
  try {
    const j = row("job-event");
    second.jobs.jobs.set(j.id, j);
    second.jobs.consume(j, { event: "clarify.request", prompt_id: "pevent", question: "q", choices: ["a"], timeout_s: 300 });
    assert.equal(j.question.timeoutSeconds, 300, "the gateway's own statement for THIS prompt outranks the config read");
    assert.match(j.question.windowFrom, /timeout_s/, "and the record says so");
  } finally {
    second.done();
  }
});

test("an unlimited config draws no countdown at all rather than a bar with no end", (t) => {
  const { jobs, done } = jobsWith(homeWith(t, { config: "clarify:\n  timeout: 0\n" }));
  try {
    const j = row("job-unlimited");
    jobs.jobs.set(j.id, j);
    jobs.consume(j, { event: "clarify.request", prompt_id: "pu", question: "q", choices: ["a"] });
    assert.equal(j.question.timeoutSeconds, null);
    assert.equal(j.question.deadline, null, "the gateway waits forever, so the card promises no end");
  } finally {
    done();
  }
});
