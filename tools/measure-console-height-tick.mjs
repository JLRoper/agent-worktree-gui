#!/usr/bin/env node
// Two console-height cases the shipped gate does not drive: a height BELOW the cap, and the REAL 30 s resync net.
//
//   node tools/measure-console-height-tick.mjs                 # ephemeral port, own sandbox
//   node tools/measure-console-height-tick.mjs --json <path>    # keep the raw ledger
//   node tools/measure-console-height-tick.mjs --keep           # leave the sandbox behind
//
// EXIT CODE: 0 every case that was exercised held, 1 a case was exercised and failed, 2 the browser half did not run.
// A case that provably could not be exercised prints NOT-EXERCISED and claims nothing (it does not pass).
//
// WHY THIS TOOL EXISTS. tools/verify-console-height.mjs gates the store on every path that replaces or builds a
// console, but it only ever drags a box ABOVE its cap (420 px against a 320 px row cap and a 230 px workspace cap), and
// it drives the resync path by CALLING resync() rather than by letting the panel's own 30 s interval do it. That leaves
// two questions open, and both are answerable only by measurement:
//
//   1. THE BRANCH BELOW THE CAP. `applyStoredHeight` applies the stored number and lifts `max-height` only when the
//      number is above the cap it reads off the page. A reader who SHRINKS a console to 200 px therefore goes down the
//      "leave the cap to the sheet" branch, which no gate exercises: the rebuild must come back at 200 px with the cap
//      still at 320 px, not on the cap and not at the content height. Same for the reload, where a fresh document reads
//      the store back.
//   2. THE REAL 30 s INTERVAL. The net calls `resync()` only when `wtLive.quiet()` says the board has been silent for
//      20 s or the EventSource is closed. The scanner publishes `row` frames on this panel's configured 5 s cadence
//      (config.json worktreeSeconds), so on a LIVE board the gate may never open and the timer may never rebuild
//      anything. This tool measures that directly: it counts GET /api/state (what resync() fetches) over 35 s of live
//      board, then closes the stream and waits for the interval to fire on its own — the case the net was built for —
//      and reads the console height after each tick.
//
// WHAT IS DRIVEN. A throwaway panel of this checkout (tools/panel-testkit.mjs: spare port, own PANEL_CONFIG /
// HERMES_HOME / jobs store, assistant off), a real project with a real worktree, and one card seeded with a 60-line
// transcript, so the console starts on the row's 320 px cap with somewhere to drag. The drag is a trusted CDP pointer
// on the console's own bottom-right corner, so Chromium's native `resize: vertical` does the work.
//
// The per-node `probeUid` stamp is the instrument's, not the page's: a case whose stamp is still there was carried, not
// rebuilt, and the case that measures a REBUILD asserts the stamp changed.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { git, startPanel } from "./panel-testkit.mjs";

const CAP_ROW = 320; // .agents-block .job-out (public/style.css)
const SMALL = 200; // a dragged height BELOW the cap
const BIG = 420; // above the cap, so the cap has to be lifted with it
const QUIET_WAIT_MS = 35_000; // one 30 s interval plus slack
const TICK_WAIT_MS = 40_000;
const ROW = "tk-row";
const PROJECT = "gui";

const KEEP = process.argv.includes("--keep");
const JSON_OUT = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;

const cases = [];
let failures = 0;
let checks = 0;
let idle = 0;
const check = (ok, label, detail = "") => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  return ok;
};
const claimNothing = (label, detail) => {
  idle += 1;
  console.log(`NOT-EXERCISED  ${label}  ${detail}`);
};
const near = (a, b, tol = 1) => Math.abs(Number(a) - Number(b)) <= tol;
const record = (name, row) => {
  cases.push({ name, ...row });
  console.log(`CASE ${name}: ${JSON.stringify(row)}`);
};

function makeRepo(dir, name) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "first"]);
}

function seed(dir, tree) {
  const now = Date.now();
  const lines = Array.from({ length: 60 }, (_, k) => ({
    kind: "out",
    text: `${ROW} line ${k + 1}: the console is a fixed height box and its content is longer than the box`,
    lid: k + 1,
    at: now - 600_000 + k * 4,
  }));
  const job = {
    id: "tk1001",
    thread: ROW,
    turn: 0,
    prompt: `measure: ${ROW}`,
    cwd: tree,
    status: "done",
    exitCode: 0,
    ownerPath: tree,
    worktreePath: tree,
    startedAt: new Date(now - 600_000).toISOString(),
    endedAt: new Date(now - 540_000).toISOString(),
    durationMs: 60_000,
    finalMessage: "done",
    lines,
  };
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ savedAt: new Date(now).toISOString(), jobs: [job] }, null, 1));
}

const measure = (page, out) =>
  page.evaluate((o) => {
    const pre = document.querySelector(`pre[data-out="${o}"]`);
    if (!pre) return null;
    const r = pre.getBoundingClientRect();
    const cs = getComputedStyle(pre);
    return {
      out: pre.dataset.out || "",
      h: +r.height.toFixed(1),
      b: +r.bottom.toFixed(1),
      r: +r.right.toFixed(1),
      inlineH: pre.style.height || "",
      inlineMax: pre.style.maxHeight || "",
      max: cs.maxHeight,
      client: pre.clientHeight,
      scroll: pre.scrollHeight,
      uid: pre.dataset.probeUid || "",
    };
  }, out);

// Park the corner where a drag of `room` px has space: growing needs the corner above the viewport floor, shrinking needs
// it below the ceiling. A corner sitting on the floor can only be dragged 20 px before the pointer leaves the window.
async function makeRoom(page, thread, out, room) {
  await page.evaluate(
    ({ t, o, need }) => {
      document.querySelector(`.job[data-thread="${t}"]`)?.scrollIntoView({ block: "center" });
      const pre = document.querySelector(`pre[data-out="${o}"]`);
      if (!pre) return;
      const r = pre.getBoundingClientRect();
      const wantY = need > 0 ? window.innerHeight - Math.abs(need) - 40 : Math.abs(need) + 40;
      const delta = r.bottom - wantY;
      if (Math.abs(delta) > 4) window.scrollBy(0, delta);
    },
    { t: thread, o: out, need: room },
  );
  await page.waitForTimeout(200);
  return measure(page, out);
}

async function show(page, thread, out, room = 0) {
  if (room) return makeRoom(page, thread, out, room);
  await page.evaluate((t) => document.querySelector(`.job[data-thread="${t}"]`)?.scrollIntoView({ block: "center" }), thread);
  await page.waitForTimeout(150);
  return measure(page, out);
}

const stamp = (page, out) =>
  page.evaluate((o) => {
    const pre = document.querySelector(`pre[data-out="${o}"]`);
    if (!pre) return "";
    pre.dataset.probeUid = `p${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
    return pre.dataset.probeUid;
  }, out);

async function grab(page, thread, out, room = 0) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const m = await show(page, thread, out, room);
    if (!m) return { x: 0, y: 0, from: null, pinned: false };
    // `resize: vertical` puts its grip in the bottom-right 16 px, but 16 px in lands on the scrolling box's own
    // scrollbar corner, so the pointer goes 5 px in from the edge.
    const GRIP = 5;
    const x = m.r - GRIP;
    const y = m.b - GRIP;
    const onBox = await page.evaluate(
      ({ px, py }) => Boolean(document.elementFromPoint(px, py)?.closest?.("pre.job-out")),
      { px: x, py: y },
    );
    if (!onBox) {
      await page.waitForTimeout(250);
      continue;
    }
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(60);
    const after = await measure(page, out);
    // The press landed when the pointerdown pinned the height it found: that inline style is the proof.
    if (after && after.inlineH === `${m.h}px`) return { x, y, from: m, pinned: true };
    await page.mouse.up();
    await page.waitForTimeout(250);
  }
  return { x: 0, y: 0, from: null, pinned: false };
}

async function dragOnce(page, thread, out, target) {
  const seedM = await measure(page, out);
  const room = seedM ? target - seedM.h : 0;
  const g = await grab(page, thread, out, room);
  if (!g.pinned) {
    console.log(`DRAG-NOT-TAKEN  the press never landed on the console's corner (${out})`);
    return { from: g.from, after: await measure(page, out), pinned: false };
  }
  // FIRST TRY: the whole drag as one stepped gesture. The board's scroll anchor moves the corner between separate
  // moves, so a drag walked down in small increments stops at a different point each run.
  const targetY = g.y + (target - g.from.h);
  await page.mouse.move(g.x, targetY, { steps: Math.max(4, Math.min(40, Math.abs(target - g.from.h))) });
  await page.waitForTimeout(80);
  const oneShot = await measure(page, out);
  if (oneShot && Math.abs(oneShot.h - target) <= 2) {
    await page.mouse.up();
    await page.waitForTimeout(120);
    return { from: g.from, pressed: oneShot, after: await measure(page, out), pinned: true };
  }
  let py = g.y + (oneShot ? oneShot.h - g.from.h : 0);
  let stall = 0;
  let last = oneShot ? oneShot.h : g.from.h;
  for (let i = 0; i < 60; i += 1) {
    const cur = await measure(page, out);
    if (!cur) break;
    const gap = target - cur.h;
    if (Math.abs(gap) <= 1) break;
    stall = Math.abs(cur.h - last) < 0.5 ? stall + 1 : 0;
    if (stall >= 4) break;
    last = cur.h;
    py += Math.sign(gap) * Math.min(16, Math.abs(gap));
    await page.mouse.move(g.x, py);
    await page.waitForTimeout(55);
  }
  await page.waitForTimeout(40);
  const pressed = await measure(page, out);
  await page.mouse.up();
  await page.waitForTimeout(120);
  return { from: g.from, pressed, after: await measure(page, out), pinned: true };
}

// A missed gesture is repeated, up to three presses, each starting from the height the last one left; the height
// reported is the one the drag ACTUALLY reached, never the constant asked for.
async function dragTo(page, thread, out, target) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const r = await dragOnce(page, thread, out, target);
    last = r;
    if (r.pinned && r.after && Math.abs(r.after.h - target) <= 3) return r;
    if (!r.pinned) continue;
    await page.waitForTimeout(250);
  }
  if (last && last.pinned && last.after) console.log(`DRAG-SHORT  ${out} reached ${last.after.h}px of ${target}px`);
  return last;
}

// The status change exactly as a `job` frame delivers it: the panel's own updateJob() with the run starting and
// finishing, which is the call that takes the card through a rebuild.
const finishTurn = (page, thread) =>
  page.evaluate((t) => {
    const j = [...state.jobs.values()].find((x) => (x.thread || x.id) === t);
    if (!j) return null;
    updateJob({ ...j, status: "running", endedAt: null, exitCode: null });
    updateJob({ ...j, status: "done", exitCode: 0, endedAt: new Date().toISOString() });
    return j.id;
  }, thread);

const servedHash = async (base) => {
  const res = await fetch(`${base.replace(/\/$/, "")}/app.js`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
};

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("a below-cap console height and the real 30 s resync", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
    process.exit(2);
  }
  const work = mkdtempSync(path.join(tmpdir(), "wtgui-console-height-tick-"));
  const root = path.join(work, "rootA");
  const repo = path.join(root, PROJECT);
  makeRepo(repo, PROJECT);
  const tree = path.join(repo, ".worktrees", "wt-1");
  git(repo, ["worktree", "add", "-q", "-b", "feature-1", tree]);
  seed(work, tree);

  const panel = await startPanel({
    dir: work,
    config: {
      scanRoots: [root],
      projects: [],
      refreshSeconds: 30,
      worktreeSeconds: 5, // the panel's own config.json cadence, and the reason a live board may never be quiet
      fetchSeconds: -1,
      assistant: { enabled: false },
      remoteBranchPolicy: "local-only",
      defaultCwd: root,
    },
  });

  // GET /api/state is what resync() fetches, so the panel's own interval is observable from the server side whatever the
  // page's function bindings look like. Nothing else in this run fetches it after the first paint.
  const stateFetches = [];
  const waitStateFetch = async (page, since, timeoutMs) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const hit = stateFetches.find((t) => t >= since);
      if (hit) return hit;
      await page.waitForTimeout(250);
    }
    return null;
  };

  try {
    const served = await servedHash(panel.base);
    console.log(`sandbox: ${panel.base}`);
    console.log(`served app.js: sha256=${served.sha256} bytes=${served.bytes}`);

    await withBrowser(
      async ({ page, pageErrors }) => {
        page.on("request", (r) => {
          try {
            if (r.method() === "GET" && new URL(r.url()).pathname === "/api/state") stateFetches.push(Date.now());
          } catch {
            /* a request whose URL will not parse is not the board's resync */
          }
        });
        // Count every SSE frame kind, so "the board was never quiet" can name what kept it awake.
        await page.addInitScript(() => {
          window.__evtFrames = {};
          try {
            const orig = EventSource.prototype.addEventListener;
            EventSource.prototype.addEventListener = function (type, fn, opts) {
              const self = this;
              return orig.call(
                self,
                type,
                function (e) {
                  try {
                    window.__evtFrames[type] = (window.__evtFrames[type] || 0) + 1;
                  } catch {
                    /* counting must never break the handler */
                  }
                  return fn.call(self, e);
                },
                opts,
              );
            };
          } catch {
            /* no EventSource to wrap: the frame counts stay empty and say so */
          }
        });

        await openPage(page, panel.base, { selector: "pre.job-out" });
        await page.waitForFunction(() => typeof state !== "undefined" && state.rows && state.jobs, null, { timeout: 30_000 });
        await page.waitForFunction(() => [...state.rows.values()].length > 0, null, { timeout: 60_000 });
        const openRows = () =>
          page.evaluate(() => {
            for (const r of state.rows.values()) {
              state.expandedProjects.add(r.project);
              state.expanded.add(`${r.project}::${r.path}`);
            }
            renderAll();
          });
        await openRows();
        await page.waitForSelector(`.job[data-thread="${ROW}"] pre.job-out`, { state: "visible", timeout: 30_000 });
        const rowOut = await page.evaluate((t) => document.querySelector(`.job[data-thread="${t}"] pre.job-out`)?.dataset.out || "", ROW);
        if (!rowOut) {
          console.log("NO-CONSOLE  the row's console never painted");
          process.exit(3);
        }

        // ---- 1. a shrink, below the cap ------------------------------------------------------
        {
          const armed = await show(page, ROW, rowOut);
          check(Boolean(armed), "shrink: the console is on the page", `out=${rowOut}`);
          check(armed && near(armed.max.replace("px", ""), CAP_ROW), "shrink: it starts on the row's 320px cap", `max=${armed?.max}`);
          const drag = await dragTo(page, ROW, rowOut, SMALL);
          const after = drag?.after || (await measure(page, rowOut));
          check(after && near(after.h, SMALL), "shrink: the drag takes the box below its cap", `h=${after?.h} want ${SMALL}`);
          check(after && after.inlineH === `${SMALL}px`, "shrink: the released height is pinned inline", `inlineH=${JSON.stringify(after?.inlineH)}`);
          // The DRAG itself always leaves max-height: none - its pointerdown lifts the cap and the pointerup only puts it
          // back for a press that did not move. The branch under test is what a REBUILD does with a below-cap number.
          check(after && after.inlineMax === "none", "shrink: the drag leaves the cap lifted, as its own gesture does", `inlineMax=${JSON.stringify(after?.inlineMax)}`);
          const stored = await page.evaluate((o) => (state.outHeights || {})[o] ?? null, rowOut);
          check(stored === SMALL, "shrink: the shrink is recorded against the turn", `outHeights[${rowOut}]=${JSON.stringify(stored)}`);
          record("shrink (below cap)", { out: rowOut, from: armed?.h, armed: after?.h, inlineH: after?.inlineH, inlineMax: after?.inlineMax, max: after?.max });
        }

        // ---- 2. the status change that replaces the node: 200px back, cap untouched -----------
        {
          const before = { ...(await measure(page, rowOut)), uid: await stamp(page, rowOut) };
          const turn = await finishTurn(page, ROW);
          await page.waitForTimeout(250);
          const after = await measure(page, rowOut);
          check(Boolean(turn), "status change: the run's own change was delivered through updateJob", `turn=${turn}`);
          if (!after) check(false, "status change: the console is on the page again");
          else {
            check(after.uid !== before.uid, "status change: the box really was rebuilt (new node)", `uid ${before.uid} -> ${after.uid || "(fresh)"}`);
            check(near(after.h, SMALL), "status change: it comes back at the shrunk height, not the cap", `h=${after.h} want ${SMALL}`);
            check(after.inlineH === `${SMALL}px`, "status change: with the height pinned inline", `inlineH=${JSON.stringify(after.inlineH)}`);
            check(after.inlineMax === "" && near(after.max.replace("px", ""), CAP_ROW),
              "status change: the cap still applies, because 200px is under it", `inlineMax=${JSON.stringify(after.inlineMax)} max=${after.max}`);
          }
          record("status change at 200px (below cap)", {
            before: before.h,
            after: after?.h,
            inlineH: after?.inlineH,
            inlineMax: after?.inlineMax,
            max: after?.max,
            replaced: Boolean(after && after.uid !== before.uid),
          });
        }

        // ---- 3. reload: a new document, the store read back ----------------------------------
        {
          await page.reload({ waitUntil: "domcontentloaded" });
          await page.waitForFunction(() => typeof state !== "undefined" && state.rows && state.jobs, null, { timeout: 30_000 });
          await page.waitForFunction(() => [...state.rows.values()].length > 0, null, { timeout: 60_000 });
          await openRows();
          const visible = await page
            .waitForSelector(`.job[data-thread="${ROW}"] pre.job-out`, { state: "visible", timeout: 15_000 })
            .then(() => true)
            .catch(() => false);
          if (visible) {
            const painted = await page.evaluate((o) => Boolean(document.querySelector(`pre[data-out="${o}"]`)), rowOut);
            // A fresh document opens only the thread's latest turn; press the turn's own head if the console is not there.
            if (!painted) await page.click(`[data-toggle-turn="${rowOut}"] .turn-text`).catch(() => {});
            await page.waitForTimeout(200);
          }
          const after = await measure(page, rowOut);
          const kept = await page.evaluate((o) => (state.outHeights || {})[o] ?? null, rowOut);
          check(Boolean(after), "reload: the console is painted again", `out=${rowOut}`);
          check(kept === SMALL, "reload: the store survived the reload", `outHeights[${rowOut}]=${JSON.stringify(kept)}`);
          check(after && near(after.h, SMALL), "reload: the box comes back at the shrunk height", `h=${after?.h} want ${SMALL}`);
          check(after && after.inlineH === `${SMALL}px`, "reload: with the height pinned inline", `inlineH=${JSON.stringify(after?.inlineH)}`);
          check(after && after.inlineMax === "" && near(after.max.replace("px", ""), CAP_ROW),
            "reload: and the cap still applies", `inlineMax=${JSON.stringify(after?.inlineMax)} max=${after?.max}`);
          record("reload at 200px (below cap)", { store: kept, after: after?.h, inlineH: after?.inlineH, inlineMax: after?.inlineMax, max: after?.max });
        }

        const frameCounts = () => page.evaluate(() => ({ ...(window.__evtFrames || {}) }));
        const quietState = () =>
          page.evaluate(() => ({
            ageMs: state.lastEventAt ? Date.now() - state.lastEventAt : null,
            streamOpen: state.es?.readyState === 1,
            quiet: Boolean(wtLive?.quiet({ lastEventAt: state.lastEventAt, streamOpen: state.es?.readyState === 1, paused: state.paused })),
          }));

        // ---- 4. a LIVE board: does the 30 s interval fire at all? -----------------------------
        {
          const framesBefore = await frameCounts();
          const since = Date.now();
          const tick = await waitStateFetch(page, since, QUIET_WAIT_MS);
          const q = await quietState();
          const framesAfter = await frameCounts();
          const deltaFrames = Object.fromEntries(
            Object.entries(framesAfter)
              .map(([k, v]) => [k, v - (framesBefore[k] || 0)])
              .filter(([, v]) => v > 0),
          );
          if (tick) {
            check(true, "live board: the REAL 30 s interval fired resync() on its own", `tick at +${tick - since}ms, quiet age ${q.ageMs}ms, frames=${JSON.stringify(deltaFrames)}`);
          } else {
            claimNothing(
              "live board: the REAL 30 s interval fired",
              `no GET /api/state in ${QUIET_WAIT_MS / 1000}s; quiet=${q.quiet} age=${q.ageMs}ms frames since start=${JSON.stringify(deltaFrames)}`,
            );
          }
          record("live board, no resync", { fired: Boolean(tick), quiet: q.quiet, ageMs: q.ageMs, frames: deltaFrames });
        }

        // ---- 5. the REAL interval with a DEAD stream, at 200px -------------------------------
        // The net's own comment is "a safety net for a stream that has gone quiet or died". A closed socket makes
        // `quiet()` true, so the next 30 s tick calls resync() - the real timer, not a hand call - and the console's
        // height has to survive that rebuild.
        {
          const before = { ...(await measure(page, rowOut)), uid: await stamp(page, rowOut) };
          await page.evaluate(() => state.es?.close());
          const since = Date.now();
          const tick = await waitStateFetch(page, since, TICK_WAIT_MS);
          const q = await quietState();
          if (!tick) {
            claimNothing("dead stream: the REAL 30 s tick fired", `no GET /api/state in ${TICK_WAIT_MS / 1000}s; streamOpen=${q.streamOpen} quiet=${q.quiet}`);
          } else {
            check(true, "dead stream: the REAL 30 s interval fired resync() with the stream closed", `tick at +${tick - since}ms after the close, streamOpen=${q.streamOpen}`);
            const after = await measure(page, rowOut);
            check(Boolean(after), "dead stream: the console is still on the page");
            check(after && after.uid === before.uid, "dead stream: resync carried the node (moved, not replaced)", `uid ${before.uid} -> ${after?.uid}`);
            check(after && near(after.h, SMALL), "dead stream: the shrunk height survived the tick", `h=${after?.h} want ${SMALL}`);
            check(after && after.inlineH === `${SMALL}px`, "dead stream: with the height pinned inline", `inlineH=${JSON.stringify(after?.inlineH)}`);
            record("real 30s tick at 200px (dead stream)", {
              tickAfterMs: tick - since,
              streamOpen: q.streamOpen,
              before: before.h,
              after: after?.h,
              inlineH: after?.inlineH,
              sameNode: Boolean(after && after.uid === before.uid),
            });
          }
        }

        // ---- 6. the same real tick with the box ABOVE the cap (cap lifted) -------------------
        {
          const drag = await dragTo(page, ROW, rowOut, BIG);
          const armed = drag?.after || (await measure(page, rowOut));
          check(armed && near(armed.h, BIG), "dead stream, above the cap: the console is dragged past its cap", `h=${armed?.h} want ${BIG}`);
          const before = { ...armed, uid: await stamp(page, rowOut) };
          const since = Date.now();
          const tick = await waitStateFetch(page, since, TICK_WAIT_MS);
          const q = await quietState();
          if (!tick) {
            claimNothing("dead stream, above the cap: a second REAL 30 s tick fired", `no GET /api/state in ${TICK_WAIT_MS / 1000}s; quiet=${q.quiet} streamOpen=${q.streamOpen}`);
          } else {
            check(true, "dead stream, above the cap: the REAL interval fired again", `tick at +${tick - since}ms, streamOpen=${q.streamOpen}`);
            const after = await measure(page, rowOut);
            check(after && after.uid === before.uid, "dead stream, above the cap: the tick carried the node", `uid ${before.uid} -> ${after?.uid}`);
            check(after && near(after.h, BIG), "dead stream, above the cap: the height survived the tick", `h=${after?.h} want ${BIG}`);
            check(after && after.inlineH === `${BIG}px` && after.inlineMax === "none",
              "dead stream, above the cap: inline height pinned and the cap still lifted",
              `inlineH=${after?.inlineH} inlineMax=${after?.inlineMax} max=${after?.max}`);
            record("real 30s tick at 420px (dead stream)", {
              tickAfterMs: tick - since,
              streamOpen: q.streamOpen,
              before: before.h,
              after: after?.h,
              inlineH: after?.inlineH,
              inlineMax: after?.inlineMax,
              sameNode: Boolean(after && after.uid === before.uid),
            });
          }
        }

        check(pageErrors.length === 0, "the page threw nothing", pageErrors.slice(0, 3).join(" | "));
      },
      { viewport: { width: 1440, height: 1600 } },
    );
  } finally {
    await panel.stop?.();
    if (JSON_OUT) {
      mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
      writeFileSync(path.resolve(JSON_OUT), JSON.stringify({ at: new Date().toISOString(), checks, failures, idle, cases }, null, 2));
      console.log(`capture: ${path.resolve(JSON_OUT)}`);
    }
    if (!KEEP) rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    else console.log(`sandbox kept: ${work}`);
  }

  console.log(failures ? `RESULT: FAIL (${failures} of ${checks} checks)` : `RESULT: PASS (${checks} checks)`);
  if (idle) console.log(`not exercised: ${idle} case(s) - they claim nothing`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
