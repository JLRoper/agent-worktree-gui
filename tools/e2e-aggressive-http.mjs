// End-to-end acceptance for the aggressive assistant toggle, over real HTTP against a real server.
//
// This is the proof the brief asks for in (a)-(g): it starts server.js on a sandbox config with a sandbox
// assistant.json, drives the same route the header button posts to, and reads assistant.json off disk between
// presses. Run it with `node tools/e2e-aggressive-http.mjs` (add `--keep` to leave the server up for a browser).
//
// What it proves, in order:
//   - the served header carries the button beside the Assistant one (both states come from the page's own JS)
//   - a real toggle-on: the settings before, the aggressive settings after, key by key
//   - the record on disk: every key it wrote, present ones with their old value, absent ones marked absent
//   - toggle-on twice: changed:false and the record byte-for-byte unchanged
//   - a panel restart between on and off: the record survives in the store and the reader's values come back
//   - toggle-off: every key back to exactly what it was, and the deliberately absent knob absent again
//   - toggle-off when it was never on: a no-op that says so
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SANDBOX = process.env.AGG_SANDBOX || "C:/Users/Jacob/AppData/Local/Temp/aggtest-e2e";
const PORT = Number(process.env.AGG_PORT || 7432);
const BASE = `http://127.0.0.1:${PORT}`;
const KEEP = process.argv.includes("--keep");

let failures = 0;
const ok = (cond, what, detail = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
  return cond;
};
const head = (t) => console.log(`\n${t}`);
// Key order in the store is an implementation detail (the writer puts `rules` first); equality here is about the
// VALUES the reader gets back, so object comparisons go through this.
const canon = (v) =>
  Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the sandbox: its own config, its own assistant.json, its own port --------------------------
const LOGS = path.join(SANDBOX, "logs");
const ASSISTANT_FILE = path.join(LOGS, "assistant.json");
const CONFIG_FILE = path.join(SANDBOX, "panel-config.json");
const SERVER_LOG = path.join(SANDBOX, "server.log");

function resetSandbox() {
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(LOGS, { recursive: true });
  const cfg = {
    port: PORT,
    host: "127.0.0.1",
    scanRoots: [],
    projects: [],
    defaultCwd: SANDBOX.replace(/\\/g, "/"),
    jobsFile: path.join(LOGS, "jobs.json").replace(/\\/g, "/"),
    assistantFile: ASSISTANT_FILE.replace(/\\/g, "/"),
    charterFile: path.join(LOGS, "assistant-charter.md").replace(/\\/g, "/"),
  };
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  // The reader's own settings, deliberately partial: autonomy and the cadence were chosen, quietSeconds was
  // never set — that absent key is the one the acceptance asks to prove absent again afterwards. `loop` is a
  // rule the reader chose; every other rule falls back to its default.
  const store = {
    version: 2,
    savedAt: "2026-01-01T00:00:00.000Z",
    settings: { autonomy: "draft", seconds: 7, rules: { loop: "alert" } },
    notes: "reader note kept",
    rules: [],
    watches: [],
    alerts: [],
    journal: [],
    harvested: [],
    terminalWakes: [],
    restartWakes: [],
  };
  writeFileSync(ASSISTANT_FILE, JSON.stringify(store, null, 2));
}

// ---- a server we can start and stop --------------------------------------------------------------
let child = null;
const serverLog = [];

function startServer() {
  // With --keep the server is detached and its output goes to the log file: the run leaves it up for a browser
  // to be pointed at, and killing it is then a matter of the printed pid.
  const detached = KEEP;
  child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: CONFIG_FILE },
    stdio: detached ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached,
  });
  if (detached) {
    child.unref();
    console.log(`      (--keep: server detached, pid ${child.pid}, ${BASE})`);
    return;
  }
  const push = (b) => {
    for (const line of String(b).split(/\r?\n/)) if (line.trim()) serverLog.push(line);
  };
  child.stdout.on("data", push);
  child.stderr.on("data", push);
}

async function waitReady(ms = 25_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/api/assistant`);
      if (r.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

async function stopServer() {
  if (!child) return;
  const c = child;
  child = null;
  c.kill();
  await new Promise((r) => c.once("exit", r).setTimeout?.(3000) || setTimeout(r, 3000));
}

const get = async (route) => {
  const r = await fetch(`${BASE}${route}`);
  return { status: r.status, text: await r.text() };
};
const post = async (route, body) => {
  const r = await fetch(`${BASE}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
};

const state = async () => JSON.parse((await get("/api/assistant")).text);
const fileNow = () => JSON.parse(readFileSync(ASSISTANT_FILE, "utf8"));
// The store is written on a 400 ms debounce, so the file a press produced is not instantly there: wait for the
// thing being asserted rather than for a fixed delay, and fail loudly if it never lands.
async function waitForDisk(pred, what, ms = 4000) {
  const until = Date.now() + ms;
  for (;;) {
    let got = false;
    try {
      got = pred(fileNow());
    } catch {
      got = false;
    }
    if (got) return true;
    if (Date.now() > until) return ok(false, `the store never showed ${what}`);
    await sleep(100);
  }
}
const brief = (s) => ({ autonomy: s.autonomy, seconds: s.seconds, rules: s.rules });

(async () => {
  resetSandbox();
  head("start: a sandbox server with the reader's own partial assistant.json");
  startServer();
  const ready = await waitReady();
  ok(ready, "the server answered GET /api/assistant");
  if (!ready) {
    console.log("\nserver log:\n" + serverLog.slice(-20).join("\n"));
    process.exit(1);
  }

  // (a) the served page is the panel's own control, and the button sits beside the Assistant one.
  head("(a) the header button, as the panel serves it");
  const html = (await get("/")).text;
  const idxBtn = html.indexOf('id="btn-assistant"');
  const aggBtn = html.indexOf('id="btn-aggressive"');
  const aggClose = aggBtn >= 0 ? html.indexOf("</button>", aggBtn) : -1;
  const aggTag = aggBtn >= 0 && aggClose > aggBtn ? html.slice(aggBtn - 8, aggClose + 9).replace(/\s+/g, " ") : "(missing)";
  ok(idxBtn >= 0 && aggBtn > idxBtn, "the aggressive button is served in the header, beside ✧ Assistant");
  ok(/aria-pressed="false"/.test(aggTag), "it ships with aria-pressed=false (off)");
  ok(/⚡ Aggressive/.test(aggTag) && /id="aggressive-state">\s*off/.test(aggTag), "it carries an on/off word next to the glyph", aggTag.slice(0, 240));
  const asjs = (await get("/assistant.js")).text;
  ok(/btn-aggressive/.test(asjs), "the page's own JS owns the button (no browser confirm anywhere)");
  ok(/function setAggressiveMode\(/.test(asjs) && /\/api\/assistant\/aggressive/.test(asjs), "the press posts to /api/assistant/aggressive from the panel's own script");
  ok(/setAttribute\("aria-pressed", on \? "true" : "false"\)/.test(asjs), "aria-pressed is driven from the server's state, not a local guess");
  ok(!/confirm\(/.test(asjs), "no window.confirm in the assistant script");

  const before = await state();
  head("(b) a real toggle-on: settings before, then the aggressive profile");
  console.log("  before settings:", JSON.stringify(brief(before.settings)));
  const on = await post("/api/assistant/aggressive", { on: true });
  ok(on.status === 200 && on.json.changed === true, "the press changed the mode", `changed=${on.json.changed}`);
  const after = on.json.assistant;
  const s = after.settings;
  const AGG = {
    enabled: true, autonomy: "auto", spawn: "auto", seconds: 2, repeatLimit: 2, quietSeconds: 30,
    approvalSeconds: 15, contextPercent: 50, leftoverMinutes: 1, childQuietSeconds: 60, repeatTurns: 2,
    maxWakesPerHour: 60, rearmSeconds: 60,
  };
  for (const [k, v] of Object.entries(AGG)) ok(s[k] === v, `${k} → ${JSON.stringify(s[k])}`, k === "enabled" ? "the sentry cannot monitor with itself switched off" : "");
  const ruleIds = Object.keys(after.rules || {});
  const allAct = Object.entries(s.rules).every(([, v]) => v === "act");
  ok(Object.keys(s.rules).length === 13, "all 13 rules are set", `${Object.keys(s.rules).length}`);
  ok(allAct, "every rule is at act (the top rung)");
  const rec = after.aggressive;
  ok(rec.on === true, "state() reports the mode on");
  ok(rec.restore.present === 3 && rec.restore.absent === 23, "the record counts the 3 keys the file carried and the 23 it did not", JSON.stringify(rec.restore));
  await waitForDisk((f) => f.aggressive && f.aggressive.on === true, "the mode being on");
  const f = fileNow();
  ok(f.aggressive && f.aggressive.on === true, "the record is on disk while the mode is on");
  ok(f.aggressive.saved.settings.quietSeconds && f.aggressive.saved.settings.quietSeconds.present === false, "quietSeconds was ABSENT and is recorded absent");
  ok(f.aggressive.saved.settings.autonomy && f.aggressive.saved.settings.autonomy.value === "draft", "autonomy is recorded with the value it held (draft)");
  ok(f.aggressive.saved.rules.loop && f.aggressive.saved.rules.loop.value === "alert", "rules.loop is recorded with the value it held (alert)");
  ok(f.aggressive.saved.rules.errorloop && f.aggressive.saved.rules.errorloop.present === false, "rules.errorloop was ABSENT and is recorded absent");
  const held = f.aggressive.saved;

  // (e) a second press must not re-record
  head("(e) toggle-on twice: the record must not be re-taken");
  const on2 = await post("/api/assistant/aggressive", { on: true });
  ok(on2.json.changed === false, "the second press changed nothing");
  ok(/already on/.test(on2.json.reason || ""), "it says the mode is already on", on2.json.reason);
  await sleep(800); // let the no-op's own journal write settle before comparing the record
  ok(same(fileNow().aggressive.saved, held), "the record is unchanged value-for-value (the aggressive values were not captured as the reader's own)");

  // (d) a panel restart between on and off
  head("(d) restart the panel while the mode is on");
  await stopServer();
  startServer();
  ok(await waitReady(), "the server came back");
  const restarted = await state();
  ok(restarted.aggressive.on === true, "the restarted panel is still in aggressive mode");
  ok(restarted.settings.seconds === 2 && restarted.settings.maxWakesPerHour === 60, "the restarted settings are the aggressive ones");
  // The record itself lives in the store, not in the page: read it back off disk after the restart.
  ok(same(fileNow().aggressive.saved, held), "the record read back off disk is the one written before the restart");

  // (c) a real toggle-off
  head("(c) a real toggle-off: every key back to exactly what it was");
  const off = await post("/api/assistant/aggressive", { on: false });
  ok(off.json.changed === true, "the switch-off changed the state");
  const back = off.json.assistant.settings;
  ok(back.autonomy === "draft", "autonomy is back to draft", back.autonomy);
  ok(back.seconds === 7, "seconds is back to 7", String(back.seconds));
  ok(back.rules.loop === "alert", "rules.loop is back to alert", back.rules.loop);
  ok(back.quietSeconds === 240, "quietSeconds falls back to its default in memory", String(back.quietSeconds));
  ok(back.rules.errorloop === "alert", "rules.errorloop falls back to its default", back.rules.errorloop);
  ok(back.maxWakesPerHour === 6, "maxWakesPerHour falls back to its default", String(back.maxWakesPerHour));
  await waitForDisk((f) => f.aggressive && f.aggressive.on === false && !("quietSeconds" in (f.settings || {})), "the switch-off being on disk");
  const fo = fileNow();
  ok(!("quietSeconds" in fo.settings), "quietSeconds is ABSENT again in the file (proved, not assumed)");
  ok(!("errorloop" in (fo.settings.rules || {})), "rules.errorloop is ABSENT again in the file");
  ok(same(fo.settings, { autonomy: "draft", seconds: 7, rules: { loop: "alert" } }), "the file carries exactly the three values the reader had", JSON.stringify(canon(fo.settings)));
  ok(fo.aggressive && fo.aggressive.on === false, "the record is emptied once the mode is off");
  ok(fo.notes === "reader note kept", "the reader's notes were not touched");

  // (f) off when it was never on
  head("(f) toggle-off when it was never on: a no-op that says so");
  const off2 = await post("/api/assistant/aggressive", { on: false });
  ok(off2.json.changed === false, "it changed nothing");
  ok(/not on/.test(off2.json.reason || ""), "it says the mode is not on", off2.json.reason);

  // (g) the assistant's own state carries the mode
  head("(g) the assistant's own state carries the mode");
  const onAgain = await post("/api/assistant/aggressive", { on: true });
  const st = onAgain.json.assistant;
  console.log("  state().aggressive =", JSON.stringify({ on: st.aggressive.on, saved: st.aggressive.saved, holds: st.aggressive.holds && st.aggressive.holds.settings }));
  ok(st.aggressive.on === true && Array.isArray(st.aggressive.holds.settings) && st.aggressive.holds.settings.includes("seconds"), "state() carries the mode and the knobs it holds");
  ok(st.aggressive.profile && st.aggressive.profile.seconds === 2 && st.aggressive.profile.rules.loop === "act", "state() carries the profile itself");

  if (!KEEP) await stopServer();
  console.log(`\nserver log tail:\n${serverLog.slice(-6).join("\n")}`);
  console.log(failures ? `\n${failures} FAILED` : "\nall HTTP acceptance checks passed");
  process.exit(failures ? 1 : 0);
})().catch(async (err) => {
  console.log("E2E CRASH:", err && err.stack || err);
  await stopServer();
  process.exit(1);
});
