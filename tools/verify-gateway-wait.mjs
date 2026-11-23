// HARNESS: LIVE GATE - a run whose stream has sent nothing says so in the console BODY, with an age that ticks.
// The reader's card, in a real browser: a run whose stream has sent NOTHING must say so in the console BODY, with an
// age that ticks, and stop saying it the moment a frame arrives.
//
//   node tools/verify-gateway-wait.mjs             # this checkout
//   node tools/verify-gateway-wait.mjs --root <dir> # serve another checkout (a `git archive` export)
//   node tools/verify-gateway-wait.mjs --out <dir> # also save the two card shots (silent, then first frame)
//
// WHY. Measured on the reader's own card (thread wtgui-read-queue-row-248-first-the-e75f5b, run run_1ab0c80b): POST at
// 15:09:01, the first event of ANY kind at 15:10:24 - 82 s in which the head badge said "no events yet · 56s" and the
// console body was blank, so a live run read as a dead panel. This drives the shipped page against a stub Runs API
// whose stream holds the connection open and says nothing, then speaks once:
//
//   1. at subscribe the body carries ONE dim row saying the run started and the gateway has sent nothing yet, with an
//      age that ticks (the row is the console's first line, where the reader looks);
//   2. past PULSE_SILENT_SECONDS the row states the silence plainly, with the age, and still makes no claim about the
//      model - while the HEAD badge keeps its own "no events yet" wording;
//   3. the first frame annotates the SAME row (no second row, no clock left running);
//   4. a run that settles having sent nothing says so once, in that row.
//
// Exit codes: 0 every assertion held; 1 one failed; 2 the run could not measure what it claims (no Playwright, no card).
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, notRun, withBrowser } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SILENT_SECONDS = Number(opt("--silent", "22")); // one second past PULSE_SILENT_SECONDS, which is 20
const OUT = opt("--out", null); // where the two card shots go, when asked for
const results = [];
let checks = 0;
let failures = 0;
const ok = (name, cond, detail = "") => {
  checks += 1;
  if (cond) {
    console.log(`PASS  ${name}${detail ? `: ${detail}` : ""}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
  results.push({ name, ok: Boolean(cond), detail });
};
const eq = (name, got, want, detail = "") => ok(name, JSON.stringify(got) === JSON.stringify(want), detail || `got ${JSON.stringify(got)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the stub Runs API: a stream that stays open and says nothing until told ---------------------------------------
function makeGateway() {
  const runs = new Map(); // id -> { res, seq, status }
  let posts = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/v1/capabilities") {
      return json(200, { version: "wait-stub", features: { run_submission: true, run_events_sse: true, run_stop: true } });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      req.resume();
      return req.on("end", () => {
        posts += 1;
        const id = `run_wait_${posts}`;
        runs.set(id, { res: null, seq: 0, status: "running" });
        json(200, { run_id: id, status: "running" });
      });
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const rec = runs.get(one[1]);
      if (!rec) return json(404, { error: { message: "Run not found", code: "run_not_found" } });
      return json(200, { run_id: one[1], status: rec.status, output: "", usage: { total_tokens: 0, input_tokens: 0, output_tokens: 0 } });
    }
    const ev = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (ev && req.method === "GET") {
      const rec = runs.get(ev[1]);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": open\n\n");
      if (!rec) return res.end();
      rec.res = res;
      req.on("close", () => {
        if (rec.res === res) rec.res = null;
      });
      return;
    }
    const stop = /^\/v1\/runs\/([^/]+)\/stop$/.exec(url.pathname);
    if (stop && req.method === "POST") {
      const rec = runs.get(stop[1]);
      if (rec) {
        rec.status = "cancelled";
        rec.res?.end();
        rec.res = null;
      }
      return json(200, { status: "cancelled" });
    }
    json(404, {});
  });
  return {
    listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))),
    idOf: (n) => `run_wait_${n}`,
    // One frame of the run's own stream - the gateway finally speaking.
    say(id, evt) {
      const rec = runs.get(id);
      if (!rec?.res) return false;
      const seq = rec.seq++;
      rec.res.write(`id: ${seq}\ndata: ${JSON.stringify({ ...evt, run_id: id, seq, timestamp: Date.now() / 1000 })}\n\n`);
      return true;
    },
    close: () =>
      new Promise((r) => {
        for (const rec of runs.values()) rec.res?.end();
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

const readCard = (page, thread) =>
  page.evaluate((t) => {
    const card = document.querySelector(`.job[data-thread="${t}"]`);
    const out = card?.querySelector("pre.job-out");
    const row = out?.querySelector("[data-gwait]") || null;
    const pulse = card?.querySelector(".live-pulse");
    return {
      hasCard: Boolean(card),
      head: (pulse?.querySelector(".pulse-text")?.textContent || "").trim(),
      headCls: pulse?.className || "",
      rowText: row ? row.textContent.trim() : null,
      label: row?.querySelector("[data-gwait-label]")?.textContent || "",
      age: row?.querySelector("[data-gwait-age]")?.textContent || "",
      waiting: out ? out.querySelectorAll("[data-gwait]").length : 0,
      marked: out ? out.querySelectorAll(".jl-gwait, .jl").length && out.querySelectorAll(".jl-gwait").length : 0,
      first: Boolean(row) && out?.firstElementChild === row,
      last: Boolean(row) && out?.lastElementChild === row,
      cls: row?.className || "",
      text: out ? out.textContent.replace(/\s+/g, " ").trim() : "",
    };
  }, thread);

async function main(pw) {
  const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-gateway-wait-"));
  const roots = [path.join(work, "rootA"), path.join(work, "rootB")];
  let sandbox = null;
  let gw = null;
  try {
    const repo = path.join(roots[0], "proj");
    const repoB = path.join(work, "rootB", "proj");
    mkdirSync(path.join(repo, "docs"), { recursive: true });
    writeFileSync(path.join(repo, "docs", "a.md"), "# Title\n\nbody line\n");
    mkdirSync(path.join(repoB, "docs"), { recursive: true });
    writeFileSync(path.join(repoB, "docs", "b.md"), "# Title\n\nbody line\n");
    const git = (args, cwd) => execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@localhost", ...args], { cwd, stdio: "pipe" });
    for (const dir of [repo, repoB]) {
      git(["init", "-q", "-b", "main"], dir);
      git(["add", "."], dir);
      git(["commit", "-q", "-m", "first"], dir);
    }

    gw = makeGateway();
    const gwPort = await gw.listen();
    sandbox = await startPanel({
      dir: work,
      root: TREE,
      config: {
        scanRoots: roots,
        projects: [],
        refreshSeconds: 30,
        worktreeSeconds: 60,
        midSeconds: 60,
        dormantSeconds: 60,
        slowSeconds: 300,
        fetchSeconds: -1,
        assistant: { enabled: false },
        remoteBranchPolicy: "local-only",
        defaultCwd: repo,
        apiServer: { url: `http://127.0.0.1:${gwPort}`, key: "probe" },
      },
      env: { API_SERVER_KEY: "" },
    });
    console.log(`      panel ${sandbox.base} (${TREE})`);

    const spawn = async (thread, cwd) => {
      const r = await fetch(`${sandbox.base}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: `probe: the gateway wait, ${thread}`, cwd, existing: true, thread }),
      }).then((x) => x.json());
      if (!r?.job) throw new Error(`spawn failed: ${JSON.stringify(r).slice(0, 300)}`);
      return r.job.id;
    };
    const runA = gw.idOf(1);
    let jobB = null;

    const verdict = await withBrowser(async ({ page }) => {
      const errors = [];
      page.on("pageerror", (e) => errors.push(String((e && e.message) || e).slice(0, 200)));
      await page.goto(sandbox.base, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30_000 });
      // The project row must exist before the card can hang under it: expanding an empty map draws nothing, and the
      // card spawned into a tree with no row is not where the reader would be looking.
      await page.waitForFunction(() => state.rows.size > 0, null, { timeout: 60_000 });
      // The 🌊 console, which is the one the reader was looking at when the body was blank. Set BEFORE the card is
      // drawn, so the card opens in that mode and the wait line arrives as a LIVE append - the reader's own case.
      await page.evaluate(() => {
        localStorage.setItem("wtgui.stream.wait-frame", "1");
        localStorage.setItem("wtgui.think.wait-frame", "0");
        localStorage.setItem("wtgui.stream.wait-settle", "1");
        localStorage.setItem("wtgui.think.wait-settle", "0");
      });
      await page.evaluate(() => {
        for (const r of state.rows.values()) {
          state.expandedProjects.add(r.project);
          state.expanded.add(`${r.project}::${r.path}`);
        }
        renderAll();
      });
      const jobA = await spawn("wait-frame", repo);
      await page.waitForSelector('.job[data-thread="wait-frame"] pre.job-out', { timeout: 45_000 });

      // ---- 1. at subscribe: one dim row in the body, age ticking, head untouched ---------------------------------
      const t0 = await readCard(page, "wait-frame");
      ok("the card draws a console body at all", t0.hasCard);
      eq("one wait row is in the body at subscribe", t0.waiting, 1, JSON.stringify(t0));
      ok("it says the run has started and the gateway has sent nothing yet", /^run started - the gateway has sent nothing yet · \d+s$/.test(t0.rowText || ""), t0.rowText);
      ok("it sits at the bottom of the body, where the newest output arrives", t0.last, `first=${t0.first} last=${t0.last}`);
      ok("the head badge still says the gateway has sent no events", /no events yet/.test(t0.head), t0.head);
      ok("the row is drawn as the console's quiet note", /jl-dim/.test(t0.cls) && /jl-gwait/.test(t0.cls), t0.cls);
      const age0 = Number((t0.age || "").replace(/[^\d]/g, "")) || 0;

      await sleep(2200);
      const t1 = await readCard(page, "wait-frame");
      const age1 = Number((t1.age || "").replace(/[^\d]/g, "")) || 0;
      ok("the age ticks in place, on the same row", t1.waiting === 1 && age1 >= age0 + 2, `${t0.age} -> ${t1.age}`);

      // ---- 2. past PULSE_SILENT_SECONDS: the silence, stated plainly, with its age --------------------------------
      const deadline = Date.now() + (SILENT_SECONDS + 12) * 1000;
      let late = t1;
      while (Date.now() < deadline) {
        late = await readCard(page, "wait-frame");
        if (/the run is still live - the gateway has sent nothing for/.test(late.label || "")) break;
        await sleep(500);
      }
      ok("past 20 s the row states the silence plainly", /the run is still live - the gateway has sent nothing for /.test(late.label || ""), late.label);
      ok("…with the age it has lasted", /^\d+m \d{2}s$|^\d+s$/.test(late.age || ""), late.age);
      ok("…and still never says the agent is thinking", !/think|reasoning|the model/i.test(late.rowText || ""), late.rowText);
      ok("the head badge is left as it was", /no events yet/.test(late.head), late.head);
      ok("the row wears the plain-silence state", /is-silent/.test(late.cls), late.cls);
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        await page.locator('.job[data-thread="wait-frame"]').screenshot({ path: path.join(OUT, "gateway-wait-silent.png") });
        console.log(`      shot ${path.join(OUT, "gateway-wait-silent.png")}`);
      }

      // ---- 3. the first frame: the SAME row is annotated, no second row, no clock left ----------------------------
      ok("the stub stream is still open to speak on", gw.say(runA, { event: "message.delta", delta: "hello from the gateway" }));
      let framed = late;
      const frameDeadline = Date.now() + 15_000;
      while (Date.now() < frameDeadline) {
        framed = await readCard(page, "wait-frame");
        if (framed.waiting === 0 && /^an event from the gateway arrived after /.test(framed.text)) break;
        await sleep(250);
      }
      ok("the first frame replaces the wait", framed.waiting === 0, `waiting rows: ${framed.waiting}`);
      ok("…with the measured wait, in the same console", /an event from the gateway arrived after \d+(\.\d+)?s/.test(framed.text), framed.text.slice(0, 160));
      ok("…and the clock is gone", !/is-silent/.test(framed.cls || "") && framed.marked === 0, `${framed.cls} marked=${framed.marked}`);
      ok("…no second row about the same wait", (framed.text.match(/from the gateway arrived/g) || []).length === 1, framed.text.slice(0, 200));
      if (OUT) {
        await page.locator('.job[data-thread="wait-frame"]').screenshot({ path: path.join(OUT, "gateway-wait-first-frame.png") });
        console.log(`      shot ${path.join(OUT, "gateway-wait-first-frame.png")}`);
      }

      // ---- 4. a run that settles having sent nothing, says so once ----------------------------------------------
      // A second card, in a tree of its own, spawned now and stopped before its stream ever speaks: the reader's
      // "the run was started and then nothing happened at all" case.
      jobB = await spawn("wait-settle", repoB);
      await page.waitForSelector('.job[data-thread="wait-settle"] pre.job-out', { timeout: 45_000 });
      const silentB = await readCard(page, "wait-settle");
      eq("the second card starts with its own wait row", silentB.waiting, 1, JSON.stringify({ text: silentB.rowText, waiting: silentB.waiting }));
      const cancel = await fetch(`${sandbox.base}/api/jobs/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: jobB }),
      }).then((r) => r.json());
      ok("the silent run is cancelled through the panel's own route", cancel?.ok !== false, JSON.stringify(cancel).slice(0, 120));
      let ended = null;
      const endDeadline = Date.now() + 20_000;
      while (Date.now() < endDeadline) {
        ended = await readCard(page, "wait-settle");
        if (/the run ended after .* with no event from the gateway/.test(ended.text || "")) break;
        await sleep(250);
      }
      ok("a run that settles without a frame says so", /the run ended after .* with no event from the gateway/.test(ended.text || ""), (ended.text || "").slice(0, 200));
      ok("…once, with no wait row left ticking", ended.waiting === 0, `waiting rows: ${ended.waiting}`);
      eq("…in exactly one row", (ended.text.match(/with no event from the gateway/g) || []).length, 1);
      ok("no page errors while any of this was drawn", errors.length === 0, errors.join(" | "));
      return { runA, runB: gw.idOf(2), jobA, jobB };
    });
    console.log(`      runs ${verdict.runA} / ${verdict.runB}`);
  } finally {
    await gw?.close().catch(() => {});
    if (sandbox?.stop) await sandbox.stop().catch(() => {});
    if (!sandbox?.keep) rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

const playwright = loadPlaywright({ root: path.resolve(HERE, "..") });
if (!playwright) {
  notRun("verify-gateway-wait", "Playwright is not installed for this checkout");
  process.exit(2);
}
try {
  await main(playwright);
} catch (e) {
  failures += 1;
  console.log(`FAIL  the run itself: ${String((e && e.stack) || e).slice(0, 800)}`);
}
console.log(`\n${checks - failures}/${checks} checks held (${TREE})`);
process.exit(failures ? 1 : 0);
