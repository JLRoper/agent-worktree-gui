// The console flicker, caught in a browser: a tool burst drawn as ONE stream (the 🌊) and a burst drawn
// condensed are the same `.tgrp`, but `toolGroupHtml` gives them opposite shapes — condensed draws a head
// and hides the body, flat draws no head and never hides it. So a card whose flat flag changes between two
// renders shows the same group expanded in one event and collapsed in the next.
//
//   node tools/verify-console-flicker.mjs
//   node tools/verify-console-flicker.mjs --report C:/CodeReviews/agent-worktree-gui
//
// WHAT IS DRIVEN
//   * a throwaway panel of its own (tools/panel-testkit.mjs: spare port, own PANEL_CONFIG, own jobsFile,
//     own HERMES_HOME, API_SERVER_KEY empty) serving THIS worktree's public/, with a seeded job store
//   * the page's own live path: the seeded turn is flipped to `running` by a `job` frame on the captured
//     EventSource, then every console line is delivered as a real `jobline` frame — appends are what a run does
//   * a MutationObserver on the console container records every node added, removed, or whose hidden/class
//     flips, with the timestamp and the node's data-tgrp/data-gstate, and a screenshot is taken at each state
//
// WHAT IT ASSERTS
//   (1) an append never flips a group body open/closed on a settled card (0 hidden/data-gflat flips expected)
//   (2) one console never mixes a flat group and a condensed group of the same burst
//   (3) the 🌊 toggle repaints the card, so the console cannot keep nodes drawn under the old flag
// On today's tree (2) and (3) fail — that is the finding this tool carries, and the repro a fix is measured
// against. Exit code is 1 while any of them fails.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const require = createRequire(import.meta.url);

const REPORT_DIR = process.argv.includes("--report") ? process.argv[process.argv.indexOf("--report") + 1] : "C:/CodeReviews/agent-worktree-gui";
const THREAD = "probe-console-flicker";
const JOB = "turn-probe-1";

let checks = 0;
let failures = 0;
const check = (name, got, want) => {
  checks += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function loadPlaywright() {
  for (const root of [process.env.PANEL_PLAYWRIGHT_ROOT, process.env.PLAYWRIGHT_ROOT, ROOT, process.cwd(), "C:/Users/roper/AppData/Roaming/npm/node_modules"].filter(Boolean)) {
    try {
      return require(path.join(root, "node_modules", "playwright"));
    } catch {
      /* not there */
    }
    try {
      return require(root);
    } catch {
      /* not there */
    }
  }
  try {
    return require("playwright");
  } catch {
    return null;
  }
}

// ---- the panel: a sandbox with a seeded card, no projects, no gateway -------------------------------------------
async function startSandbox(pw) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-flicker-"));
  const logs = path.join(dir, "logs");
  mkdirSync(logs, { recursive: true });
  const jobsFile = path.join(logs, "jobs.json");
  const port = await freePort();
  const now = Date.now();
  // `load()` rewrites a `running` job as `interrupted`, so the card is seeded finished and flipped in the browser.
  writeFileSync(
    jobsFile,
    JSON.stringify({
      savedAt: new Date(now).toISOString(),
      jobs: [
        {
          id: JOB,
          thread: THREAD,
          turn: 1,
          status: "done",
          prompt: "console flicker probe",
          displayPrompt: "console flicker probe",
          cwd: dir,
          worktree: false,
          worktreePath: null,
          projectPath: null,
          ownerPath: null,
          branch: null,
          runId: "run_probe",
          startedAt: new Date(now - 120_000).toISOString(),
          endedAt: new Date(now - 30_000).toISOString(),
          model: "probe/model",
          lines: [
            { kind: "init", text: "run started", lid: 1, at: now - 110_000 },
            { kind: "text", text: "reading the tree first", lid: 2, at: now - 109_000 },
            { kind: "tool", text: "💻 terminal · ls -la", lid: 3, at: now - 108_000 },
            { kind: "tool-out", text: "  ↳ terminal · 0.31s", lid: 4, at: now - 107_690 },
            { kind: "store", text: "total 12", lid: 5, at: now - 107_690 },
          ],
          artifacts: [],
          attachments: [],
          subagents: [],
        },
      ],
    }),
    "utf8",
  );
  const cfgPath = path.join(dir, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify(
      {
        port,
        host: "127.0.0.1",
        scanRoots: [path.join(dir, "empty-root")],
        threads: 1,
        worktreeSeconds: 60,
        midSeconds: 60,
        dormantSeconds: 60,
        slowSeconds: 60,
        refreshSeconds: 3600,
        fetchSeconds: -1,
        projects: [],
        jobsFile,
        projectsCacheFile: path.join(logs, "projects.json"),
        assistantFile: path.join(logs, "assistant.json"),
        assistant: { enabled: false },
        remoteBranchPolicy: "local-only",
      },
      null,
      2,
    ),
    "utf8",
  );
  mkdirSync(path.join(dir, "empty-root"), { recursive: true });
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: cfgPath, HERMES_HOME: path.join(dir, "home"), API_SERVER_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const out = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => out.push(d));
  child.stderr.on("data", (d) => out.push(d));
  const base = `http://127.0.0.1:${port}`;
  const until = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the sandbox panel exited: ${out.join("")}`);
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > until) throw new Error(`the sandbox panel did not answer /api/health in 30s: ${out.join("")}`);
    await sleep(120);
  }
  return { base, dir, port, child, log: () => out.join("") };
}

// ---- the page-side harness -----------------------------------------------------------------------------------
function initScript({ thread, job, mode }) {
  try {
    localStorage.setItem("wtgui.autoCollect", "0");
  } catch {}
  try {
    if (mode === "stream") localStorage.setItem(`wtgui.stream.${thread}`, "1");
    else localStorage.removeItem(`wtgui.stream.${thread}`);
  } catch {}
  const Real = window.EventSource;
  window.__es = [];
  window.EventSource = function (...a) {
    const es = new Real(...a);
    window.__es.push(es);
    return es;
  };
  window.EventSource.prototype = Real.prototype;
  Object.assign(window.EventSource, Real);

  const probe = { t0: performance.now(), recs: [], appends: [], events: [], paints: [], armed: false };
  window.__probe = probe;

  const groupOf = (el) => (el.closest && el.closest(".tgrp")) || (el.matches && el.matches(".tgrp") ? el : null);
  const keysOf = (el) => {
    const g = groupOf(el);
    return g ? { tgrp: g.dataset.tgrp || "", gstate: g.dataset.gstate || "", gflat: g.dataset.gflat || "" } : {};
  };
  const selOf = (el) => {
    if (!el || el.nodeType !== 1) return String(el && el.nodeName);
    if (el.matches("pre.job-out")) return "pre.job-out";
    const k = keysOf(el);
    const part = el.classList.contains("tgrp") ? "" : ` > .${[...el.classList].join(".")}`;
    return `pre.job-out > .tgrp[data-gstate="${k.gstate || "$none"}"]${part}`;
  };
  const bodyOf = (el) => {
    const g = groupOf(el);
    const b = g && g.querySelector(".tgrp-body");
    return b ? { hidden: Boolean(b.hidden), h: Math.round(b.getBoundingClientRect().height) } : null;
  };
  probe.arm = () => {
    if (probe.armed) return true;
    const host = document.getElementById("jobs");
    if (!host) return false;
    new MutationObserver((muts) => {
      for (const m of muts) {
        const t = Math.round((performance.now() - probe.t0) * 10) / 10;
        if (m.type === "childList") {
          const hostInConsole = Boolean(m.target.closest && m.target.closest("pre.job-out"));
          for (const n of m.addedNodes) {
            if (!(n.nodeType === 1 && (n.matches?.("pre.job-out") || n.closest?.("pre.job-out") || hostInConsole))) continue;
            probe.recs.push({ t, kind: "add", target: selOf(n), keys: keysOf(n), body: bodyOf(n) });
          }
          for (const n of m.removedNodes) {
            // A removed node is already detached, so it is named by what it was.
            if (!(n.nodeType === 1 && (n.matches?.("pre.job-out") || n.classList?.contains("tgrp") || n.classList?.contains("jl")))) continue;
            probe.recs.push({ t, kind: "remove", target: selOf(n), keys: keysOf(n), body: bodyOf(n) });
          }
        } else if (m.type === "attributes") {
          if (!m.target.closest || !m.target.closest("pre.job-out")) continue;
          const attr = m.attributeName;
          const groupish = m.target.matches(".tgrp, .tgrp-body, .tgrp-head");
          if (attr === "class" && !groupish) continue;
          if (attr === "data-gflat" && !groupish) continue;
          const now = m.target.getAttribute(attr);
          if (now === m.oldValue) continue;
          probe.recs.push({ t, kind: "attr", attr, old: m.oldValue, new: now, target: selOf(m.target), keys: keysOf(m.target), body: bodyOf(m.target) });
        }
      }
    }).observe(host, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ["hidden", "class", "data-gflat"] });
    probe.armed = true;
    return true;
  };
  // One row per group on screen: is it drawn flat (no head, body never hidden) or condensed (head, body toggle)?
  probe.state = () =>
    [...document.querySelectorAll("pre.job-out .tgrp")].map((g) => {
      const b = g.querySelector(".tgrp-body");
      return {
        gstate: g.dataset.gstate || "",
        tgrp: g.dataset.tgrp || "",
        gflat: g.dataset.gflat || "",
        flat: g.classList.contains("tgrp-flat"),
        head: Boolean(g.querySelector(".tgrp-head")),
        hidden: Boolean(b && b.hidden),
        h: b ? Math.round(b.getBoundingClientRect().height) : -1,
      };
    });
  probe.mark = (name) => {
    const entry = { name, t: Math.round((performance.now() - probe.t0) * 10) / 10, state: probe.state(), recs: probe.recs.length };
    probe.events.push(entry);
    return entry;
  };
  probe.append = (line) => {
    const es = window.__es[window.__es.length - 1];
    const t = Math.round((performance.now() - probe.t0) * 10) / 10;
    probe.appends.push({ t, kind: line.kind, lid: line.lid });
    es.dispatchEvent(new MessageEvent("jobline", { data: JSON.stringify({ type: "jobline", id: job, line }) }));
    return { t, state: probe.state(), recs: probe.recs.length };
  };
  probe.job = (patch) => {
    const cur = state.jobs.get(job);
    const es = window.__es[window.__es.length - 1];
    es.dispatchEvent(new MessageEvent("job", { data: JSON.stringify({ job: { ...cur, ...patch } }) }));
    return true;
  };
  probe.setStream = (on) => {
    setStreamMode(thread, on);
    return probe.mark(`setStreamMode(${on})`);
  };
  probe.openFirstGroup = () => {
    const g = document.querySelector("pre.job-out .tgrp");
    const btn = g && g.querySelector(".tgrp-more");
    if (!btn) return null;
    btn.click();
    return probe.mark("reader opens the first group");
  };
  // What the live append path uses to decide flat: the card's own answer, then the node's.
  probe.flatSource = () => {
    const j = state.jobs.get(job);
    return { cardThread: j ? j.thread : null, streamOnThread: streamOn(j ? j.thread : job), streamOnJobId: streamOn(job) };
  };
  probe.instrument = () => {
    if (probe.instrumented) return true;
    for (const n of ["paintStreamConsole", "streamBodyHtml", "toolGroupHtml", "renderConversation", "renderJobs"]) {
      const orig = window[n];
      if (typeof orig !== "function") continue;
      window[n] = function (...a) {
        const t = Math.round((performance.now() - probe.t0) * 10) / 10;
        const entry = { n, t };
        if (n === "toolGroupHtml") {
          entry.key = String(a[1]);
          entry.open = Boolean(a[3]);
          entry.flat = Boolean(a[6] && a[6].flat);
        }
        if (n === "paintStreamConsole") probe.paints.push(t);
        probe.calls = probe.calls || [];
        if (probe.calls.length < 3000) probe.calls.push(entry);
        return orig.apply(this, a);
      };
    }
    probe.instrumented = true;
    return true;
  };
}

// ---- the four states a card can be in -----------------------------------------------------------------------
async function scenario(pw, sandbox, { mode, name, steps, shots }) {
  const browser = await pw.chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  await ctx.addInitScript(initScript, { thread: THREAD, job: JOB, mode });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e && e.message ? e.message : e)));
  await page.goto(sandbox.base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__probe && window.__es && window.__es.length > 0, null, { timeout: 20_000 });
  await page.waitForSelector(`.job[data-thread="${THREAD}"]`, { timeout: 20_000 });
  await page.evaluate(() => window.__probe.instrument());
  await page.evaluate((job) => window.__probe.job({ status: "running", endedAt: null, startedAt: new Date(Date.now() - 4000).toISOString() }), JOB);
  await page.waitForSelector("pre.job-out", { timeout: 20_000 });
  await page.evaluate(() => window.__probe.arm());
  await sleep(350);

  const shot = async (label) => {
    const file = path.join(SHOT_DIR, `${mode}-${label}.png`);
    await page.locator("pre.job-out").screenshot({ path: file });
    return file;
  };
  const trail = [];
  const record = async (label) => {
    const m = await page.evaluate((l) => window.__probe.mark(l), label);
    trail.push({ label, ...m });
    return m;
  };
  await record("start");
  const result = await steps({ page, shot, record, trail });
  const raw = await page.evaluate(() => ({ recs: window.__probe.recs, appends: window.__probe.appends, paints: window.__probe.paints, calls: window.__probe.calls || [], flatSource: window.__probe.flatSource() }));
  await ctx.close();
  await browser.close();
  return { mode, name, trail, steps: result, errors, ...raw };
}

const appendPair = async (page, i, tag) => {
  const tool = { kind: "tool", text: `💻 terminal · ${tag}-${i}`, lid: 1000 + i * 2, at: Date.now() };
  const res = await page.evaluate((l) => window.__probe.append(l), tool);
  await sleep(150);
  const out = { kind: "tool-out", text: `  ↳ terminal · 0.${i % 10}s`, lid: 1001 + i * 2, at: Date.now() };
  const res2 = await page.evaluate((l) => window.__probe.append(l), out);
  await sleep(150);
  return [res, res2];
};

// ---- main ----------------------------------------------------------------------------------------------------
const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-HALF-NOT-RUN  playwright is not installed for this node; nothing was measured");
  process.exit(2);
}
mkdirSync(REPORT_DIR, { recursive: true });
const SHOT_DIR = path.join(REPORT_DIR, "console-flicker-shots");
mkdirSync(SHOT_DIR, { recursive: true });

const sandbox = await startSandbox(pw);
console.log(`sandbox panel on ${sandbox.base} (port ${sandbox.port}, cwd ${ROOT})`);

const results = [];
try {
  // A: the default card — condensed, untouched. Appends must not toggle a body.
  results.push(
    await scenario(pw, sandbox, {
      mode: "condensed",
      name: "A default (condensed), six appends",
      steps: async ({ page, shot, record, trail }) => {
        await shot("A0-start");
        for (let i = 0; i < 3; i++) await appendPair(page, i, "plain");
        await sleep(400);
        await record("settled");
        await shot("A1-settled");
        return { trail };
      },
    }),
  );

  // B: 🌊 on, then turned off — the card is not repainted by the toggle, so the next append draws a
  // condensed group into a console full of flat ones.
  results.push(
    await scenario(pw, sandbox, {
      mode: "stream",
      name: "B one stream on, turned off, then appends",
      steps: async ({ page, shot, record, trail }) => {
        await shot("B0-stream-on");
        await record("stream on");
        await page.evaluate(() => window.__probe.setStream(false));
        await shot("B1-after-toggle-off");
        await record("stream off (no repaint)");
        for (let i = 0; i < 2; i++) await appendPair(page, i, "after-toggle");
        await sleep(500);
        await record("settled");
        await shot("B2-mixed");
        return { trail };
      },
    }),
  );

  // C: condensed, then 🌊 on — then the thinking sweep re-renders the console and the same group changes shape.
  results.push(
    await scenario(pw, sandbox, {
      mode: "condensed",
      name: "C condensed, one stream turned on, append, sweep",
      steps: async ({ page, shot, record, trail }) => {
        await shot("C0-condensed");
        await record("condensed");
        await page.evaluate(() => window.__probe.setStream(true));
        await shot("C1-after-toggle-on");
        await record("stream on (no repaint)");
        const r = await page.evaluate(() => window.__probe.append({ kind: "tool", text: "💻 terminal · after-toggle", lid: 2000, at: Date.now() }));
        await shot("C2-after-append");
        await record("append after toggle");
        await sleep(3200);
        await shot("C3-after-sweep");
        await record("after sweep");
        return { trail, appendAt: r.t };
      },
    }),
  );

  // D: one stream, plain appends — how often does the console rewrite itself?
  results.push(
    await scenario(pw, sandbox, {
      mode: "stream",
      name: "D one stream, appends over 8s (cadence)",
      steps: async ({ page, shot, record, trail }) => {
        const t0 = await page.evaluate(() => performance.now() - window.__probe.t0);
        for (let i = 0; i < 5; i++) await appendPair(page, i, "cadence");
        await sleep(6000);
        await record("settled");
        await shot("D0-settled");
        return { trail, t0 };
      },
    }),
  );
  // E: one stream, a tall console — does the sweep's wholesale innerHTML cost the reader their scroll?
  results.push(
    await scenario(pw, sandbox, {
      mode: "stream",
      name: "E one stream, reader scrolled to the middle, sweep",
      steps: async ({ page, shot, record, trail }) => {
        for (let i = 0; i < 12; i++) await appendPair(page, i, "tall");
        const before = await page.evaluate(() => {
          const out = document.querySelector("pre.job-out");
          // The real cap is `.agents-block .job-out { max-height: 320px }`; an unattached card's console grows and
          // the page scrolls instead, so the scroller is made here to measure the console's own scrollTop.
          out.style.maxHeight = "260px";
          out.style.overflowY = "auto";
          state.outPinned["turn-probe-1"] = false;
          out.scrollTop = Math.round((out.scrollHeight - out.clientHeight) / 2);
          return { top: out.scrollTop, max: out.scrollHeight - out.clientHeight, paints: window.__probe.paints.length };
        });
        await shot("E0-scrolled");
        await sleep(5200);
        const after = await page.evaluate(() => {
          const out = document.querySelector("pre.job-out");
          return { top: out.scrollTop, max: out.scrollHeight - out.clientHeight, paints: window.__probe.paints.length };
        });
        await shot("E1-after-sweep");
        await record("settled");
        return { trail, scroll: { before, after } };
      },
    }),
  );
} finally {
  sandbox.child.kill();
}

// ---- read the evidence ---------------------------------------------------------------------------------------
const a = results[0];
const b = results[1];
const c = results[2];
const d = results[3];
const e = results[4];

const hiddenFlips = results.flatMap((r) => r.recs.filter((x) => x.kind === "attr" && x.attr === "hidden").map((x) => ({ mode: r.mode, ...x })));
const flatFlipAttr = results.flatMap((r) => r.recs.filter((x) => x.kind === "attr" && x.attr === "data-gflat"));
const isGroup = (t) => /^pre\.job-out > \.tgrp\[data-gstate="[^"]*"\]$/.test(t || "");
const groupAdds = results.map((r) => ({
  name: r.name,
  appends: r.appends.length,
  groupAdds: r.recs.filter((x) => x.kind === "add" && isGroup(x.target)).length,
  groupRemoves: r.recs.filter((x) => x.kind === "remove" && isGroup(x.target)).length,
  unattributed: r.recs.filter((x) => x.kind === "add" && !isGroup(x.target) && !String(x.target).includes(" > .")).length,
}));

// (1) an append must not toggle a body on a settled card
check("(1) hidden-attribute flips of .tgrp-body across all four states", hiddenFlips.length, 0);
check("(1) data-gflat attribute flips (a node is replaced, never re-flagged)", flatFlipAttr.length, 0);

// (2) one console never mixes shapes
const mixed = (st) => st.filter((g) => g.flat).length > 0 && st.filter((g) => !g.flat).length > 0;
const bSettled = b.trail.at(-1);
const cAppend = c.trail.find((t) => t.label === "append after toggle");
ok("(2) B settled: no console holds a flat group and a condensed group at once", !mixed(bSettled.state), JSON.stringify(bSettled.state));
ok("(2) C right after the append: no console holds a flat group and a condensed group at once", !mixed(cAppend.state), JSON.stringify(cAppend.state));

// (3) the toggle must repaint the card it changes
const bOff = b.trail.find((t) => t.label === "stream off (no repaint)");
const cOn = c.trail.find((t) => t.label === "stream on (no repaint)");
ok("(3) B: turning the stream OFF leaves no flat group on screen", bOff.state.every((g) => g.flat === false), JSON.stringify(bOff.state));
ok("(3) C: turning the stream ON leaves no condensed group on screen", cOn.state.every((g) => g.flat === true), JSON.stringify(cOn.state));

// the cadence: how often the console's innerHTML is replaced while a turn is live
const paints = d.paints.map((x) => Math.round(x));
const gaps = paints.slice(1).map((t, i) => t - paints[i]);
const cadence = { paints, gaps, median: gaps.length ? gaps.slice().sort((x, y) => x - y)[Math.floor(gaps.length / 2)] : null };

// how long after an append the next console-wide rewrite lands
const rewritesAfterAppend = [];
for (const r of [d]) for (const ap of r.appends) {
  const next = r.paints.find((p) => p > ap.t);
  if (next != null) rewritesAfterAppend.push(Math.round(next - ap.t));
}
const withinSecond = rewritesAfterAppend.filter((x) => x <= 1000).length;

console.log(`\nmeasured: ${results.map((r) => `${r.name}: ${r.appends.length} appends, ${r.recs.length} records`).join(" | ")}`);
console.log(`group node churn: ${JSON.stringify(groupAdds)}`);
console.log(`console rewrites in D: ${paints.length} at ${paints.join(", ")} ms; gaps ${gaps.join(", ")} ms`);
console.log(`next rewrite after an append: ${rewritesAfterAppend.join(", ")} ms (${withinSecond}/${rewritesAfterAppend.length} within 1 s)`);
console.log(`reader's mid-console scroll across a sweep (E): ${JSON.stringify(e.steps.scroll)}`);

// ---- the report ----------------------------------------------------------------------------------------------
const shotList = (labels) => labels.map((l) => `console-flicker-shots/${l}`).join("\n");
const report = `# The console flicker, caught in a browser (Playwright + MutationObserver)

Probe: \`tools/verify-console-flicker.mjs\` in worktree \`catch-the-console-flicke-579251\`.
Panel: a throwaway instance of THIS worktree on port ${sandbox.port} (its own \`PANEL_CONFIG\`, its own
\`jobsFile\`, its own \`HERMES_HOME\`, \`API_SERVER_KEY\` empty) — the reader's panel on 7331 was not touched.
Card: one seeded turn (\`${JOB}\` / thread \`${THREAD}\`) seeded \`done\` and flipped to \`running\` with a \`job\` frame
on the page's own captured \`EventSource\`; every console line after that is a real \`jobline\` frame.

## What blinks

\`\`\`
pre.job-out[data-out="${JOB}"] > .tgrp[data-gstate="${JOB}|<anchor>"]
\`\`\`

and the element that decides open/collapsed is its child \`> .tgrp-body\` (\`hidden\` when collapsed). The same
group is drawn two ways by one function, and the two ways are not the same shape:

| shape | markup | open? |
| --- | --- | --- |
| flat (🌊 one stream) | \`app.js:2064-2072\` — no \`.tgrp-head\`, \`<div class="tgrp-body">\` with no \`hidden\` | always expanded |
| condensed | \`app.js:2074-2077\` — \`.tgrp-head\` rows + \`<div class="tgrp-body" hidden>\` unless opened | collapsed by default |

## Proven / disproven

* **A group body does NOT close and reopen on an append.** Across ${results.reduce((n, r) => n + r.appends.length, 0)} appends in five card states the
  MutationObserver recorded **${hiddenFlips.length}** \`hidden\` flips and **${flatFlipAttr.length}** \`data-gflat\` flips. That is structural, not luck: nothing
  in the panel ever toggles a burst body in place. The two in-place toggles that DO exist are a single call's
  output (\`.call-body\`, \`app.js:13141\`) and a code box (\`.code-body\`, \`app.js:13171\`) — a \`.tgrp-body\`'s
  open/collapsed travels as **markup only** (\`app.js:2076\` writes \`hidden\` into the string), so every change of
  state is a node replacement, and "it closed and reopened" is the eye reading a remove+add.
* **The group NODE is replaced on every tool line.** \`drawJobLine\` re-renders the whole burst and swaps it in
  (\`app.js:7009\` builds it, \`app.js:7013\` \`openGroup.replaceWith(fresh)\`). Measured churn:
  ${groupAdds.map((g) => `${g.name}: ${g.groupRemoves} removes / ${g.groupAdds} adds for ${g.appends} append${g.appends === 1 ? "" : "s"}`).join(" · ")}.
* **The expanded/collapsed mismatch is real, and the flat flag is why.** One console can hold *one expanded group
  and one collapsed group of the same burst*, because the flag is decided per call site:
  * a live append to an EXISTING group reads the node: \`openGroup.dataset.gflat === "1"\` (\`app.js:7007\`);
  * a live append that STARTS a group reads **localStorage at creation time**:
    \`streamOn(state.jobs.get(evt.id)?.thread || evt.id)\` (\`app.js:7007\`; \`streamOn\` \`app.js:5863-5870\`);
  * a full card render reads \`streamOn(turn.thread || turn.id) && Boolean(globalThis.wtStream)\` (\`app.js:2142\`), and
    \`streamBodyHtml\` hardcodes \`{flat:true}\` (\`app.js:2127\`).
  And \`toolGroupHtml\` makes the two shapes mutually exclusive: flat emits no head and a body that is never
  \`hidden\` (\`app.js:2064-2072\`), condensed emits a head and \`<div class="tgrp-body" hidden>\` (\`app.js:2074-2077\`),
  and the reader's remembered open state is skipped entirely when flat (\`app.js:1816\`).
* **The 🌊 toggle cannot repaint the card it changes.** \`setStreamMode\` calls \`renderConversation(thread)\`
  (\`app.js:5872-5878\`), and \`conversationSignature\` (\`app.js:6602-6682\`) does not carry \`streamOn\` — so the
  signature matches, the card is not rebuilt, and the console keeps nodes drawn under the old flag while the
  next append draws under the new one. Measured: after turning it OFF every group was still flat
  (${JSON.stringify(bOff.state)}); after turning it ON every group was still condensed (${JSON.stringify(cOn.state)}).
* **The whole console is rewritten while a turn is live in 🌊 mode, on a ~2.4 s clock.** \`sweepThinking\`
  (\`setInterval(…, 1200)\`, \`app.js:3751\`) re-reads a live turn when its cache entry is older than 2000 ms
  (\`app.js:3738\`) → \`loadThinking\` (\`app.js:6054\`) → \`paintThink\` (\`app.js:6072\`) → \`paintStreamConsole\`, whose
  \`out.innerHTML = streamBodyHtml(...)\` (\`app.js:6110\`) replaces every node in the console. Measured in state D:
  ${paints.length} rewrites at ${paints.join(", ")} ms — gaps ${gaps.join(", ")} ms (median ${cadence.median} ms). The next rewrite after each of the
  ${rewritesAfterAppend.length} appends came ${rewritesAfterAppend.join(", ")} ms after it — ${withinSecond} of ${rewritesAfterAppend.length} within the same second as the append, which is
  what makes it read as "it flickers when a line arrives".

## The other half: is a turn's innerHTML replaced per append?

| path | when | what it replaces | what it costs |
| --- | --- | --- | --- |
| \`drawJobLine\` (\`app.js:6962\`) | every tool line | the burst's \`.tgrp\` node only (\`app.js:7013\`) | the group's text is re-created; nothing else in the console moves |
| \`paintStreamConsole\` (\`app.js:6110\`) | 🌊 cards only, on the thinking sweep (~2.4 s) | the console's whole innerHTML | every node; a reader's scroll measured **${e.steps.scroll.before.top}px before and ${e.steps.scroll.after.top}px after** a rewrite (max ${e.steps.scroll.before.max}px) |
| \`renderConversation\` (\`app.js:6807\`) | when \`conversationSignature\` changes — a status flip, an approval, a new turn | the whole \`.job\` node | scroll, selection and the caret restored explicitly (\`app.js:6828-6865\`) |
| \`renderJobs\` (\`app.js:6489-6491\`) | a snapshot carrying \`jobs\`, or an owner change | \`$("jobs").innerHTML\` — every unattached card | each console's scroll restored by \`captureScrolls\`/\`restoreScrolls\` |

An append never runs \`conversationHtml\`/\`turnBody\`: the card is guarded by \`el.dataset.sig === sig\`
(\`app.js:6821\`) and \`conversationSignature\` (\`app.js:6602-6682\`) has no per-line term — \`l.lastActiveAt\` and
\`l.tokens.total\` are deliberately out of it (\`app.js:6642-6645\`, \`6666-6668\`) and painted in place instead. So the
per-append innerHTML reset the TODO suspected does not happen; the wholesale replacement that does happen is the
sweep's, and it keeps the reader's scroll.

## Event cadence, in one line each

| event | what it does to the console |
| --- | --- |
| \`jobline\` tool/tool-out | replaces the burst's \`.tgrp\` node 1:1 (\`app.js:7013\`); no \`hidden\` flip |
| 🌊 toggled | no repaint (\`conversationSignature\` lacks \`streamOn\`); the next append may create a group in the OTHER shape |
| \`sweepThinking\` (1200 ms tick, 2000 ms freshness) | 🌊 only: rewrites the whole \`pre.job-out\` innerHTML (~2.4 s measured) |
| every 3 s (\`app.js:1626\`) | rebuilds an OPEN group's stored results when they changed (\`ensureToolStore\` → \`repaintToolGroup\`, \`app.js:1420\`), preserving the shape |
| board snapshot / \`renderJobs\` | rebuilds every unattached card (\`$("jobs").innerHTML = …\`, \`app.js:6489-6491\`) and re-derives flat from the card |

## Screenshots (open and collapsed, both on disk)

${shotList(["condensed-A0-start.png", "condensed-A1-settled.png", "stream-B0-stream-on.png", "stream-B1-after-toggle-off.png", "stream-B2-mixed.png", "condensed-C0-condensed.png", "condensed-C1-after-toggle-on.png", "condensed-C2-after-append.png", "condensed-C3-after-sweep.png", "stream-D0-settled.png", "stream-E0-scrolled.png", "stream-E1-after-sweep.png"])}

* \`condensed-C2-after-append.png\` — the money shot: the first group is **condensed and closed** (\`terminal ×1 · ls -la\`,
  a \`2 lines\` button, \`0.31s\`) while the line appended after the toggle is **flat and open** (\`terminal · after-toggle\`).
* \`stream-B2-mixed.png\` — the mirror: the first group is flat and open, the group appended after the toggle is
  condensed and closed (\`terminal ×2 · after-toggle\`, \`4 lines\`).
* \`condensed-C3-after-sweep.png\` — both groups flat and open after the sweep: the same group changed shape with
  no line arriving in between.

## The fix this hands to an agent

1. One source of truth for "is this card drawn as one stream": read \`streamOn\` once per render and pass it down,
   instead of \`streamOn(...)\` inside \`drawJobLine\` (\`app.js:7007\`) — and use \`turn.thread\`, not \`evt.id\`, for the
   lookup (an id is not a thread).
2. Put \`streamOn\` in \`conversationSignature\` (\`app.js:6602\`) so the toggle repaints the card it changes.
3. Make \`toolGroupHtml\` carry the reader's open state across the two shapes: a group drawn flat should still
   record/restore \`state.toolGroupOpen\` (today \`saved\` is skipped whenever \`flat\`, \`app.js:1816\`), so switching
   shapes does not present a different open/collapsed state.
4. If the sweep is kept, stop rebuilding the console wholesale: paint the reasoning lines in place (\`app.js:6110\`),
   the way \`drawJobLine\` appends a line.

## Repro

\`\`\`
cd C:/ProjectDevelopment/agent-worktree-gui/.worktrees/catch-the-console-flicke-579251
node tools/verify-console-flicker.mjs --report C:/CodeReviews/agent-worktree-gui
\`\`\`

Contract checks: ${checks - failures}/${checks} pass, ${failures} fail on this tree — that is the finding.
`;
mkdirSync(REPORT_DIR, { recursive: true });
writeFileSync(path.join(REPORT_DIR, "console-flicker-playwright.md"), report, "utf8");
console.log(`\nreport: ${path.join(REPORT_DIR, "console-flicker-playwright.md")}`);
console.log(`shots : ${SHOT_DIR}`);
console.log(`\n${failures ? "FAIL" : "PASS"}  ${checks - failures}/${checks} contract checks (${failures} failing on this tree)`);
process.exit(failures ? 1 : 0);
