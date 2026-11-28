#!/usr/bin/env node
// A console height the reader DRAGGED must survive every rebuild that replaces or builds the box - not come back on its
// cap, and not at whatever content height a fresh box happens to measure.
//
//   node tools/verify-console-height.mjs
//   node tools/verify-console-height.mjs --keep     # leave the sandbox behind for inspection
//
// WHAT THIS GUARDS. `.job-out` is a browser-resized box (`resize: vertical` under a max-height, public/console.css) and the
// size the reader gave it lives in ONE place: that node's inline style. Measured on 0.48.2
// (C:/CodeReviews/agent-worktree-gui/resize/rebuild.md): four rebuild triggers carried the node and held the dragged
// height to the pixel (420 -> 420, 490 -> 490, 400 -> 400), and EIGHT threw it away - a status change (490 -> 320), a new
// turn (the box gone, then 320 on unfold), a fold (421 -> 121.5, the content height), a project collapse (420 -> 69.8), a
// reload (420 -> 320), and the same two again on an unattached workspace card under its 230 px cap. The number now lives
// in `state.outHeights` (keyed by the turn id the console carries, `pre.dataset.out`) and every path that builds or
// replaces the node puts it back, lifting the cap when the height is above it.
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
// THE BAND IS THE MODULE'S. How far a console may grow is `band()` in public/core/console-grip.js, in LAYOUT px, and
// this gate asks that function with the values the press reads instead of subtracting a viewport room of its own. The
// drawn foot is then asserted against the viewport edge at 100, 90 and 110 zoom: a room that mixed the visual
// viewport with a layout top reads the same as the right one at 100 and lands 10% off the edge at the other two.
//
//   driven    a throwaway panel of this checkout (tools/panel-testkit.mjs: spare port, own PANEL_CONFIG / HERMES_HOME /
//             jobs store, assistant off) holding a real project with a real worktree, so one card is drawn in a worktree
//             row (cap 320 px) and one in the unattached workspace (cap 230 px)
//   driven    the drag itself: a trusted CDP pointer on the console's own bottom-right corner, so Chromium's native
//             `resize: vertical` machinery does the work - the same gesture tools/verify-console-resize.mjs gates
//   driven    every trigger the measurement lost the height to, through the page's own functions and controls: a status
//             change as two updateJob() frames (the call a `job` frame makes), a NEW TURN as a reply posted to the panel
//             (a stub gateway plays the run, so the turn is the panel's own - not a fabricated one the next snapshot would
//             drop), a press on the card's own head (toggleJob), a press on the turn's own head (toggleTurn), a press on
//             the project's own head (toggleProject), the page reloading, and the unattached list's wholesale rebuild
//             through renderJobs()
//   inspected that the box really was rebuilt: every console is stamped with a per-node id before its trigger, and a case
//             that finds the stamp still there reports NOT-EXERCISED rather than passing on a node it never replaced
//
// PASS = the console came back at the height it was dragged to (and, above the cap, with the cap lifted). The browser
// half needs a Playwright install; without one the script says BROWSER-HALF-NOT-RUN and exits 2 rather than passing on a
// half that never ran.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { git, startPanel } from "./panel-testkit.mjs";

const CAP_ROW = 320; // .agents-block .job-out (public/board.css)
const CAP_HOME = 230; // .job-out (public/console.css)
const ARM = 420; // the height the reader drags to, px - above both caps, so the cap has to be lifted with it
const HANDLE = 4; // where inside the console's 16 px corner the pointer is put
const ROW = "height-row";
const HOME = "height-home";
const PROJECT = "gui";
const KEEP = process.argv.includes("--keep");

let failures = 0;
let checks = 0;
let notExercised = 0;
const check = (ok, label, detail = "") => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const claimNothing = (label, detail) => {
  notExercised += 1;
  console.log(`NOT-EXERCISED  ${label}  ${detail}`);
};
const near = (a, b, tol = 1) => Math.abs(Number(a) - Number(b)) <= tol;

// ---- a stub Hermes gateway, so the "new turn" is a real one ----------------------------------------------
// A turn fabricated in the page's `state.jobs` is dropped again by the panel's next snapshot, and the card rebuilding
// from THAT is not the trigger a reader meets. So the panel runs against a stub gateway and the new turn is started the
// way a reader's reply starts one - POST /api/agents/reply - with the run played over real SSE. Nothing synthetic
// reaches the page: every turn here is one the panel's own store created and served.
function runScript(lenMs, salt) {
  const out = [];
  let t = 200;
  let i = 0;
  while (t < lenMs) {
    out.push({ at: t, evt: { event: "message.delta", delta: `probe-${salt}-word-${i} ` } });
    t += 60;
    i += 1;
  }
  out.push({ at: t + 40, evt: { event: "run.completed", status: "completed", output: `done ${salt}` } });
  return out;
}

function makeGateway(lenMs) {
  const runs = new Map();
  let posts = 0;
  const timers = new Set();
  const later = (ms, fn) => {
    const h = setTimeout(() => {
      timers.delete(h);
      fn();
    }, Math.max(0, ms));
    timers.add(h);
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/v1/capabilities") {
      return json(200, { version: "height-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true } });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      req.resume();
      req.on("end", () => {
        posts += 1;
        const id = `run_height_${posts}`;
        runs.set(id, { id, startedAt: null, script: runScript(posts * 37, lenMs) });
        json(200, { run_id: id, status: "running" });
      });
      return;
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const rec = runs.get(one[1]);
      if (!rec) return json(404, { error: { message: "Run not found", code: "run_not_found" } });
      return json(200, { run_id: rec.id, status: "running", output: "", usage: { total_tokens: 9000, input_tokens: 8100, output_tokens: 900 } });
    }
    const ev = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (ev && req.method === "GET") {
      const rec = runs.get(ev[1]);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      if (!rec) return res.end();
      res.write(": open\n\n");
      if (rec.startedAt == null) rec.startedAt = Date.now();
      let open = true;
      req.on("close", () => {
        open = false;
      });
      rec.script.forEach((step, i) => {
        later(rec.startedAt + step.at - Date.now(), () => {
          if (open) res.write(`id: ${i}\ndata: ${JSON.stringify({ ...step.evt, run_id: rec.id, seq: i, timestamp: Date.now() / 1000 })}\n\n`);
        });
      });
      return;
    }
    json(404, {});
  });
  return {
    listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))),
    close: () =>
      new Promise((r) => {
        for (const h of timers) clearTimeout(h);
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

function makeRepo(dir, name) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "first"]);
}

// Two finished agents written into the sandbox's own store BEFORE the panel boots (a running panel rewrites its store
// every ~700 ms): one owned by a worktree row, one unattached. Both transcripts are long enough that the box overflows
// its cap, which is what makes a drag mean anything. No run id and no action lines, so nothing can be re-attached or
// re-executed.
function seed(dir, tree) {
  const now = Date.now();
  const lines = (tag) =>
    Array.from({ length: 60 }, (_, k) => ({
      kind: "out",
      text: `${tag} line ${k + 1}: the console is a fixed height box and its content is longer than the box`,
      lid: k + 1,
      at: now - 600_000 + k * 4,
    }));
  const job = (id, thread, owner) => ({
    id,
    thread,
    turn: 0,
    prompt: `probe: ${thread} - drag me to ${ARM}px`,
    cwd: owner || dir,
    status: "done",
    exitCode: 0,
    ownerPath: owner || null,
    worktreePath: owner || null,
    startedAt: new Date(now - 600_000).toISOString(),
    endedAt: new Date(now - 540_000).toISOString(),
    durationMs: 60_000,
    finalMessage: "done",
    lines: lines(thread),
  });
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  writeFileSync(
    path.join(dir, "logs", "jobs.json"),
    JSON.stringify({ savedAt: new Date(now).toISOString(), jobs: [job("aaaa1001", ROW, tree), job("aaaa1002", HOME, null)] }, null, 1),
  );
}

// One console as the page draws it, found by the turn id it carries: its frame, its inline style, the cap the sheet
// resolves for it, and the per-node stamp that says whether this is still the node the reader dragged.
const measure = (page, out) =>
  page.evaluate((o) => {
    const pre = document.querySelector(`pre[data-out="${o}"]`);
    if (!pre) return null;
    const r = pre.getBoundingClientRect();
    const cs = getComputedStyle(pre);
    const gripEl = (pre.closest(".out-box") || pre.parentElement)?.querySelector?.("[data-out-grip]");
    const g = gripEl ? gripEl.getBoundingClientRect() : null;
    return {
      out: pre.dataset.out || "",
      h: +r.height.toFixed(1),
      b: +r.bottom.toFixed(1),
      r: +r.right.toFixed(1),
      // The corner the hand takes is the GRIP's, not the console's: the grip is a sibling in `.out-box` and can sit a
      // pixel or two outside the console's own edge. A press at the console's corner that misses the grip is a drag
      // that never starts, which the old native-handle fixture could not tell apart from a box that refused to grow.
      grip: g ? { r: +g.right.toFixed(1), b: +g.bottom.toFixed(1), w: +g.width.toFixed(1), h: +g.height.toFixed(1) } : null,
      inlineH: pre.style.getPropertyValue("--out-h") || "",
      inlineMax: pre.style.maxHeight || "",
      max: cs.maxHeight,
      client: pre.clientHeight,
      scroll: pre.scrollHeight,
      uid: pre.dataset.probeUid || "",
    };
  }, out);

// Bring the console into the window with room under it for the drag. Scrolling the CARD to the top leaves the console
// hundreds of pixels down a tall card, where the viewport's edge is only a few hundred px below its top and the 420px
// target would be outside the band this gate is meant to stay inside. The console is centred instead, so its top is
// roughly a third of the way down the window and the band has the room the drag needs.
async function show(page, thread, out) {
  await page.evaluate((o) => {
    document.querySelector(`pre[data-out="${o}"]`)?.scrollIntoView({ block: "center" });
  }, out);
  // The board corrects the reader's position for a few frames after a scroll (its anchor repick, then the observer's
  // answer to it). A press taken inside that window presses a card the correction is about to move, which is
  // indistinguishable from a box that refused to grow. Read twice, 220ms apart, until the two readings agree.
  let a = null;
  let b = await measure(page, out);
  for (let try_ = 0; try_ < 4; try_ += 1) {
    await page.waitForTimeout(220);
    a = b;
    b = await measure(page, out);
    if (!a || !b || (Math.abs(a.b - b.b) < 1 && Math.abs(a.h - b.h) < 1)) break;
  }
  return b;
}

// Stamp the node the reader dragged. A rebuild that replaces the console builds a fresh node from HTML, and an attribute
// set from the page is not in that HTML - so the stamp is gone exactly when the box really was replaced.
const stamp = (page, out) =>
  page.evaluate((o) => {
    const pre = document.querySelector(`pre[data-out="${o}"]`);
    if (!pre) return "";
    pre.dataset.probeUid = `p${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
    return pre.dataset.probeUid;
  }, out);

// The console as it stands, stamped: what a trigger is fired at, and the node identity it has to come back on.
async function armed(page, thread, out) {
  const m = await show(page, thread, out);
  if (!m) return null;
  return { ...m, uid: await stamp(page, out) };
}

// Press the bottom-right corner and hand back the point, so every later move is the reader's own pointer.
//
// The press is checked before it is trusted, twice. The board's own anchor sweep runs on a clock and can move the page
// between the scroll that puts the console in the window and the press a few milliseconds later, which lands the pointer
// on whatever ended up under it. A press that did not pin the height it found is released and taken again, and so is one
// that pinned a height but froze a TOP the reading did not measure: the gesture freezes the top edge at the press and the
// band's room is measured from it (public/core/console-grip.js band), so a press on a console the page had already moved
// would obey a room this gate never read - a real stop, reported as a short drag. After three tries the drag is reported
// as not taken rather than measured as if it had been.
async function grab(page, thread, out) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const m = await show(page, thread, out); // the corner has to be on screen for the press to reach the box
    if (!m) return { x: 0, y: 0, from: null, after: null, held: null, pinned: false };
    const x = (m.grip ? m.grip.r : m.r) - HANDLE;
    const y = (m.grip ? m.grip.b : m.b) - HANDLE;
    last = { x, y, from: m };
    const onBox = await page.evaluate(
      ({ px, py }) => {
        const el = document.elementFromPoint(px, py);
        // The corner is the grip's now (`[data-out-grip]`, a sibling of the console inside its `.out-box`), so a press
        // that reaches the resize gesture may report either element.
        return Boolean(el && el.closest && el.closest("pre.job-out, [data-out-grip]"));
      },
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
    const froze = await page.evaluate(() => {
      const d = window.wtConsoleGripDrag;
      return d ? { top: d.top, z: d.z, room: d.room, min: d.min, edge: d.edge } : null;
    });
    const sameTop = Boolean(froze && after) && Math.abs(froze.top * froze.z - (m.b - m.h)) <= 2;
    if (after && after.inlineH === `${m.h}px` && sameTop) return { ...last, after, held: froze, pinned: true }; // the grab pinned what it found, where it found it
    await page.mouse.up();
    await page.waitForTimeout(250);
  }
  return { ...(last || { x: 0, y: 0, from: null }), after: null, held: null, pinned: false };
}

// Drag the console to `target` px. The step is derived from the height the box is ACTUALLY at (so an interrupted or
// overshooting resize corrects itself) and the pointer accumulates from where it is, never from the corner's screen
// position: the page holds the card still while the box grows (an anchor correction), so the corner does not move down
// the viewport even as the height does.
async function dragTo(page, thread, out, target) {
  const g = await grab(page, thread, out);
  if (!g.pinned) {
    console.log(`DRAG-NOT-TAKEN  the press never landed on the console's corner (${out})`);
    return { from: g.from, pressed: null, held: null, after: await measure(page, out), pinned: false };
  }
  let py = g.y;
  let stall = 0;
  let last = g.from.h;
  for (let i = 0; i < 60; i += 1) {
    const cur = await measure(page, out);
    if (!cur) break;
    const gap = target - cur.h;
    if (Math.abs(gap) <= 1) break;
    stall = Math.abs(cur.h - last) < 0.5 ? stall + 1 : 0;
    if (stall >= 4) break; // the native resize is not following any more; stop walking the pointer down the screen
    last = cur.h;
    py += Math.sign(gap) * Math.min(20, Math.abs(gap));
    await page.mouse.move(g.x, py);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(40);
  const pressed = await measure(page, out);
  // The band the gesture is obeying, while it is still down: `want` is the pointer's own last request, `room` and `edge`
  // are the stop, so a drag that ends short says WHERE it stopped instead of printing a number the reader has to
  // reverse-engineer.
  const held = await page.evaluate(() => {
    const d = window.wtConsoleGripDrag;
    return d ? { want: d.want, room: d.room, min: d.min, edge: d.edge } : null;
  });
  await page.mouse.up();
  await page.waitForTimeout(120);
  return { from: g.from, pressed, held, after: await measure(page, out), pinned: true };
}

// ---- the triggers, all through the page's own functions ------------------------------------------------
// The status change, exactly as a `job` frame delivers it: updateJob() with the new status, twice, so the card sees a
// turn start and finish the way the panel's own stream makes it.
const finishTurn = (page, thread) =>
  page.evaluate((t) => {
    const j = [...state.jobs.values()].find((x) => (x.thread || x.id) === t);
    if (!j) return null;
    updateJob({ ...j, status: "running", endedAt: null, exitCode: null });
    updateJob({ ...j, status: "done", exitCode: 0, endedAt: new Date().toISOString() });
    return j.id;
  }, thread);

// The page's own press handlers: a real click on the control the reader would hit, not a call to the function behind it.
// The short settle first is for the harness, not the page: a trigger fires a synchronous rebuild, and a press resolved
// against the node that rebuild replaced can land on nothing.
const press = async (page, selector) => {
  await page.waitForTimeout(150);
  await page.click(selector);
  await page.waitForTimeout(80);
};
const pressCardHead = (page, thread) => press(page, `.job[data-thread="${thread}"] .job-head .agent-glyph`);
const pressTurnHead = (page, out) => press(page, `[data-toggle-turn="${out}"] .turn-text`);
const pressProjectHead = (page) => press(page, `.project-head[data-toggle-project="${PROJECT}"] h2`);

const gone = (page, out) =>
  page.waitForFunction((o) => !document.querySelector(`pre[data-out="${o}"]`), out, { timeout: 10_000 }).then(() => true).catch(() => false);
const back = (page, out) =>
  page.waitForFunction((o) => Boolean(document.querySelector(`pre[data-out="${o}"]`)), out, { timeout: 10_000 }).then(() => true).catch(() => false);

// Everything a rebuilt console has to say for itself: the height, the inline height, the lifted cap, and a node that is
// not the one the reader dragged. A trigger that left the same node in place proves nothing, and says so.
function report(label, before, after, { want = ARM } = {}) {
  if (!before) return check(false, `${label}: the console was on the page to fire the trigger at`);
  if (!after) return check(false, `${label}: the console is on the page again`);
  if (after.uid === before.uid) return claimNothing(`${label}: the box rebuilt`, `the same node survived (uid ${before.uid}) - nothing was replaced`);
  check(true, `${label}: the box really was rebuilt (new node)`, `uid ${before.uid} -> ${after.uid || "(fresh)"}`);
  check(near(after.h, want), `${label}: it comes back at the height the reader dragged it to`, `h=${after.h} want ${want}`);
  check(after.inlineH === `${want}px`, `${label}: with that height pinned in its inline style`, `inlineH=${JSON.stringify(after.inlineH)}`);
  check(after.inlineMax === "none" && after.max === "none", `${label}: and the cap that would clip it lifted`,
    `inlineMax=${JSON.stringify(after.inlineMax)} max=${after.max}`);
}

// A fold press rebuilds the card, but a collapsed card still carries its console markup (hidden by the sheet), so the fold
// is proved by the page's own state and by a NEW node, and the height is read after the press that unfolds it again.
async function foldCycle(page, label, thread, out) {
  const before = await armed(page, thread, out);
  if (!before) return check(false, `${label}: the console was on the page to fold`);
  await pressCardHead(page, thread);
  const folded = await page.evaluate((t) => state.collapsedJobs.has(t), thread);
  check(folded, `${label}: the press on the card's head folded it`);
  const hidden = await measure(page, out);
  check(Boolean(hidden) && hidden.uid !== before.uid, `${label}: folding rebuilt the card, console markup and all`,
    `uid ${before.uid} -> ${hidden ? hidden.uid || "(fresh)" : "(gone)"}`);
  await pressCardHead(page, thread);
  const open = await page.evaluate((t) => !state.collapsedJobs.has(t), thread);
  check(open, `${label}: pressing it again unfolded it`);
  report(label, before, await measure(page, out));
}

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("a dragged console height surviving a rebuild", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
    process.exit(2);
  }

  const work = mkdtempSync(path.join(tmpdir(), "wtgui-console-height-"));
  const root = path.join(work, "rootA");
  const repo = path.join(root, PROJECT);
  makeRepo(repo, PROJECT);
  const tree = path.join(repo, ".worktrees", "wt-1");
  git(repo, ["worktree", "add", "-q", "-b", "feature-1", tree]);
  seed(work, tree);

  const gateway = makeGateway(2_500);
  const gatewayPort = await gateway.listen();
  const panel = await startPanel({
    dir: work,
    config: {
      scanRoots: [root],
      projects: [],
      refreshSeconds: 30,
      worktreeSeconds: 5,
      fetchSeconds: -1,
      assistant: { enabled: false },
      remoteBranchPolicy: "local-only",
      defaultCwd: root,
      apiServer: { url: `http://127.0.0.1:${gatewayPort}`, key: "probe" },
    },
  });

  try {
    console.log(`sandbox: ${panel.base}`);
    await withBrowser(
      async ({ page, pageErrors }) => {
        // The Unattached agents card ships MINIMIZED (row 416: FIXED_DEFAULT_COLLAPSED in public/app.js), and one of the
        // two consoles under test lives in it. Open it the way a reader does - a press on the card's own head, which also
        // records the choice (`wm.fixedChosen`), so the reload later in this gate finds it open again.
        await openPage(page, panel.base, { selector: "#agents" });
        await page.waitForFunction(() => typeof state !== "undefined" && state.rows && state.jobs, null, { timeout: 30_000 });
        await page.evaluate(() => {
          if (document.getElementById("agents")?.classList.contains("fixed-collapsed")) {
            document.querySelector('[data-toggle-fixed="agents"]')?.click();
          }
        });
        const openRows = () =>
          page.evaluate(() => {
            for (const r of state.rows.values()) {
              state.expandedProjects.add(r.project);
              state.expanded.add(`${r.project}::${r.path}`);
            }
            renderAll();
          });
        // The row has to be listed before its card is drawn in it.
        await page.waitForFunction(() => [...state.rows.values()].length > 0, null, { timeout: 60_000 });
        await openRows();
        await page.waitForSelector(`.job[data-thread="${ROW}"] pre.job-out`, { state: "visible", timeout: 30_000 });
        await page.waitForSelector(`.job[data-thread="${HOME}"] pre.job-out`, { state: "visible", timeout: 30_000 });
        const rowOut = await page.evaluate((t) => document.querySelector(`.job[data-thread="${t}"] pre.job-out`)?.dataset.out || "", ROW);
        const homeOut = await page.evaluate((t) => document.querySelector(`.job[data-thread="${t}"] pre.job-out`)?.dataset.out || "", HOME);

        // ---- 0. the fixture: two consoles, each on the cap its host draws it under, each overflowing it
        // THE BAND'S EDGE IS THE VIEWPORT HERE, and the fixture has to be inside it. A row card's `.job-body` is not a
        // scrollport (the grip reads a pane only on a maximized card or the docked Chat pane), so the room is the
        // viewport's own edge; a console left low in the window has less than the 420px target and a drag would stop on
        // that edge - correctly, but it would measure the fixture's scroll position, not the dragged height's survival.
        // show() centres one console, so each room is read right after its own show: the workspace list sits above the
        // board, and centring one moves the other off screen.
        //
        // THE ROOM IS THE MODULE'S, NOT THIS FILE'S. `band()` (public/core/console-grip.js) is the one function that
        // answers the floor and the room in LAYOUT px, and the gesture obeys it. This gate used to subtract
        // `innerHeight - rect.top - 8` itself: a second copy in MIXED units (the viewport is visual, the rect is visual,
        // and the gesture divides both into layout px at the press), which only agreed with the module at 100% zoom -
        // so the gate would have failed the tree for agreeing with the module on a zoomed page. The inputs below are the
        // press's own (`top: rect.top / z`, `z`, the sheet's floor, the pane edge when there is one, the viewport, the
        // 8px gap), and the answer is the number the drag will really stop on. `stop` is that room through the module's
        // own `limit`, which is what the move and the release call.
        const bandOf = (thread, atZoom) =>
          page.evaluate(
            ({ t, zw, arm }) => {
              const pre = document.querySelector(`.job[data-thread="${t}"] pre.job-out`);
              const grip = window.wtConsoleGrip;
              if (!pre || !grip || typeof grip.band !== "function") return null;
              const r = pre.getBoundingClientRect();
              const cs = getComputedStyle(pre);
              const z = Number(zw) > 0 ? Number(zw) : grip.zoom();
              // The press finds a pane only on a maximized card or the docked Chat pane (public/core/console-grip.js
              // press); a board card has none, and the check below says so before a null pane edge is believed.
              const body = pre.closest(".job-body");
              const pane = body && (body.closest(".job.maximized") || body.closest('[data-subpane="chat"]')) ? body : null;
              const b = grip.band({
                top: r.top / z,
                z,
                floor: typeof outFloor === "function" ? outFloor(cs) : 0,
                paneBottom: pane ? pane.getBoundingClientRect().bottom : null,
                viewport: window.innerHeight,
                gap: grip.GAP_PX,
              });
              return {
                min: b.min,
                room: b.room,
                edge: b.edge,
                paneRoom: b.paneRoom,
                viewRoom: b.viewRoom,
                z,
                top: r.top,
                gap: grip.GAP_PX,
                viewport: window.innerHeight,
                pane: Boolean(pane),
                // The module's own clamp, at the room the band just answered: the height a drag to ARM lands on.
                stop: grip.limit(Number(arm), b.min, b.room),
              };
            },
            { t: thread, zw: atZoom, arm: ARM },
          );

        // The one thing a room in LAYOUT px has to satisfy: the console's foot, drawn back in VISUAL px, is the
        // viewport edge less the gap the gesture keeps under it. `top` is the rect's visual top and the room and gap are
        // layout lengths, so the scale is applied once, to the sum. The old mixed-unit room put this foot a tenth of the
        // viewport short at 90% and drew past the edge at 110% - the two readings the zoom cases below are here to catch.
        const footOnEdge = (b, tol = 1) => Boolean(b) && near(b.top + (b.room + b.gap) * b.z, b.viewport, tol);
        const foot = (b) => (b ? `${(b.top + (b.room + b.gap) * b.z).toFixed(1)}` : "?");

        const rowStart = await show(page, ROW, rowOut);
        const rowBand = await bandOf(ROW);
        // Read while THIS console is the one in the window: the workspace list sits above the board, so centring the
        // other console leaves this one below the viewport and its room on the floor.
        const rowZooms = [];
        for (const probeZoom of [0.9, 1.1]) rowZooms.push([probeZoom, await bandOf(ROW, probeZoom)]);
        const homeStart = await show(page, HOME, homeOut);
        const homeBand = await bandOf(HOME);
        if (!rowStart || !homeStart) {
          check(false, "the fixture painted both consoles", `row=${Boolean(rowStart)} home=${Boolean(homeStart)}`);
          return;
        }
        check(Boolean(rowBand && homeBand) && rowBand.room > ARM + 20 && homeBand.room > ARM + 20,
          "each console has viewport room under it for the 420px drag the band must allow",
          `row ${rowBand ? rowBand.room : "(the band did not answer)"}px home ${homeBand ? homeBand.room : "(none)"}px want > ${ARM + 20}px`);
        check(
          Boolean(rowBand && homeBand) && rowBand.edge === "viewport" && homeBand.edge === "viewport" && !rowBand.pane && !homeBand.pane,
          "each is the board-card shape: no scrollport, so the viewport is the band's only edge",
          `row edge=${rowBand ? rowBand.edge : "?"} pane=${rowBand ? rowBand.pane : "?"} | home edge=${homeBand ? homeBand.edge : "?"} pane=${homeBand ? homeBand.pane : "?"}`);
        check(
          near(rowBand && rowBand.room, rowBand && rowBand.viewRoom) && near(homeBand && homeBand.room, homeBand && homeBand.viewRoom),
          "the room is the band's own viewRoom, not a second subtraction in this file",
          `row room=${rowBand ? rowBand.room : "?"} viewRoom=${rowBand ? rowBand.viewRoom : "?"} | home room=${homeBand ? homeBand.room : "?"} viewRoom=${homeBand ? homeBand.viewRoom : "?"}`);
        check(footOnEdge(rowBand) && footOnEdge(homeBand),
          "the room is LAYOUT px: the console's foot lands on the viewport edge less the gap",
          `row foot ${foot(rowBand)} of ${rowBand ? rowBand.viewport : "?"} | home foot ${foot(homeBand)} of ${homeBand ? homeBand.viewport : "?"}`);
        // THE UNIT ITSELF, at two zooms the tree does not draw. The top is held at the pixel it was measured at, so this
        // is about the units and not about the reflow: a room that mixed a visual viewport with a layout top lands the
        // foot 10% off the edge here, and no 100% reading can see it.
        for (const [probeZoom, b] of rowZooms) {
          check(footOnEdge(b),
            `the band's room is layout px at ${Math.round(probeZoom * 100)}% zoom: the console's foot is still the viewport edge`,
            b ? `room=${b.room} top=${b.top} z=${b.z} foot=${foot(b)} viewport=${b.viewport}` : "the band did not answer");
        }
        check(Boolean(rowBand) && rowBand.stop === ARM,
          "so the 420px the drag lands on is the height the module's limit keeps",
          rowBand ? `limit(${ARM}, ${rowBand.min}, ${rowBand.room}) = ${rowBand.stop}` : "the band did not answer");
        check(near(rowStart.h, CAP_ROW) && rowStart.max === `${CAP_ROW}px`, "the row console starts on the 320px cap its row draws",
          `h=${rowStart.h} max=${rowStart.max}`);
        check(near(homeStart.h, CAP_HOME) && homeStart.max === `${CAP_HOME}px`, "the workspace console starts on the 230px cap",
          `h=${homeStart.h} max=${homeStart.max}`);
        check(rowStart.scroll > rowStart.client + 300 && homeStart.scroll > homeStart.client + 300,
          "and both transcripts scroll well inside their box, so a drag has somewhere to go",
          `row ${rowStart.scroll}>${rowStart.client} home ${homeStart.scroll}>${homeStart.client}`);

        // ---- 1. the drag: 320 -> 420 px, and the height is recorded against the turn
        const dragged = await dragTo(page, ROW, rowOut, ARM);
        check(near(dragged.after && dragged.after.h, ARM), "the drag carries the console to 420px and leaves it there",
          `h ${dragged.from ? dragged.from.h : "(no press)"} -> ${dragged.after ? dragged.after.h : "(gone)"} (band room ${dragged.held ? Math.round(dragged.held.room) : "?"} on the ${dragged.held ? dragged.held.edge : "?"} edge, pointer asked ${dragged.held && dragged.held.want != null ? Math.round(dragged.held.want) : "?"})`);
        check(dragged.after && dragged.after.inlineH === `${ARM}px` && dragged.after.inlineMax === "none",
          "the drag pinned that height and lifted the cap", `inlineH=${dragged.after ? dragged.after.inlineH : "(none)"} inlineMax=${dragged.after ? dragged.after.inlineMax : ""}`);
        const stored = await page.evaluate((o) => ({ store: (state.outHeights || {})[o], stored: localStorage.getItem("wm.outHeights") }), rowOut);
        check(stored.store === ARM, "the height is recorded against the turn the console carries", `outHeights[${rowOut}]=${JSON.stringify(stored.store)}`);
        check((() => {
          try {
            return JSON.parse(stored.stored || "{}")[rowOut] === ARM;
          } catch {
            return false;
          }
        })(), "and persisted under its own localStorage key, so a reload can find it", String(stored.stored).slice(0, 140));

        // ---- 2. control: nothing rebuilt, nothing moves
        {
          const before = await armed(page, ROW, rowOut);
          await page.waitForTimeout(400);
          const still = await measure(page, rowOut);
          check(still.uid === before.uid && near(still.h, ARM), "control: 400ms of nothing leaves the console at 420px, same node",
            `h=${still.h} sameNode=${still.uid === before.uid}`);
        }

        // ---- 3. status change - the run's own frames through the panel's updateJob()
        {
          const before = await armed(page, ROW, rowOut);
          const out = await finishTurn(page, ROW);
          if (!out) claimNothing("status change", "the turn could not be found in state.jobs");
          else report("status change", before, await measure(page, rowOut));
        }

        // ---- 4. a new turn - a reply on the same thread, which the panel starts as a real second turn. The previous
        //         turn folds (the new one is the thread's latest), so its console leaves the page.
        {
          const before = await armed(page, ROW, rowOut);
          const reply = await fetch(`${panel.base}/api/agents/reply`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ thread: ROW, text: "probe: the reader sent the next turn while that console was tall" }),
          }).then((r) => r.json());
          if (!reply || !reply.job) claimNothing("new turn", `the panel refused the reply: ${JSON.stringify(reply).slice(0, 200)}`);
          else {
            const nextId = reply.job.id;
            const appeared = await page
              .waitForFunction((id) => Boolean(state.jobs.get(id)), nextId, { timeout: 30_000 })
              .then(() => true)
              .catch(() => false);
            check(appeared, "new turn: the reply started a second turn on the thread", `turn ${nextId}`);
            const left = await gone(page, rowOut);
            check(left, "new turn: the previous turn folds and its console leaves the page", `out ${rowOut}`);
            // The thread has to settle before a press is meaningful: the run plays for ~2.5 s and the card is rebuilt
            // when it ends.
            const settled = await page
              .waitForFunction((id) => {
                const j = state.jobs.get(id);
                return j && j.status !== "running";
              }, nextId, { timeout: 45_000 })
              .then(() => true)
              .catch(() => false);
            check(settled, "new turn: the second turn finished", `turn ${nextId}`);

            // ---- 5. unfold - a real press on the previous turn's own head brings its console back, built from nothing
            await pressTurnHead(page, rowOut);
            const cameBack = await back(page, rowOut);
            check(cameBack, "unfold: a press on the turn's head brings that console back", `out ${rowOut}`);
            if (cameBack) report("unfold", before, await measure(page, rowOut));
          }
        }

        // ---- 6. fold / expand: a press on the card's own head, on a card drawn in a worktree row
        await foldCycle(page, "fold", ROW, rowOut);

        // ---- 7. project collapse / expand: the console is gone while collapsed, and the expand builds it from nothing
        {
          const before = await armed(page, ROW, rowOut);
          await pressProjectHead(page);
          const left = await gone(page, rowOut);
          check(left, "project collapse: the whole project's rows leave the page, console and all", `out ${rowOut}`);
          const wasCollapsed = await page.evaluate((p) => !state.expandedProjects.has(p), PROJECT);
          check(wasCollapsed, "project collapse: the project really is collapsed in the page's own state");
          await pressProjectHead(page);
          const cameBack = await back(page, rowOut);
          check(cameBack, "project collapse: expanding builds the card again from nothing");
          if (cameBack) report("project collapse", before, await measure(page, rowOut));
        }

        // ---- 8. reload: a new document, every card rebuilt from the store
        {
          const before = await armed(page, ROW, rowOut);
          await page.reload({ waitUntil: "domcontentloaded" });
          await page.waitForFunction(() => typeof state !== "undefined" && state.rows && state.jobs, null, { timeout: 30_000 });
          await page.waitForFunction(() => [...state.rows.values()].length > 0, null, { timeout: 60_000 });
          await openRows();
          // The previous turn is not open in a fresh document (only the thread's latest is), so the console under test
          // comes back with a press on its own head - the same press case 5 makes.
          const cameBack = await page
            .waitForSelector(`.job[data-thread="${ROW}"] pre.job-out`, { state: "visible", timeout: 15_000 })
            .then(() => true)
            .catch(() => false);
          check(cameBack, "reload: the row re-opened and its card painted");
          if (cameBack) {
            await pressTurnHead(page, rowOut);
            const isBack = await back(page, rowOut);
            const after = await measure(page, rowOut);
            const kept = await page.evaluate((o) => (state.outHeights || {})[o], rowOut);
            check(kept === ARM, "reload: the store was read back from localStorage", `outHeights[${rowOut}]=${JSON.stringify(kept)}`);
            check(isBack && after && after.uid === "", "reload: a new document, so a rebuilt node", `console back=${isBack}`);
            check(near(after ? after.h : 0, ARM) && after && after.inlineH === `${ARM}px` && after.max === "none",
              "reload: the console comes back at the height the reader dragged it to, cap lifted",
              `h=${after ? after.h : "(none)"} inlineH=${after ? after.inlineH : ""} max=${after ? after.max : ""}`);
            check(!before || !after || after.uid !== before.uid, "reload: the node before the reload is not the one after it");
          }
        }

        // ---- 9. the unattached workspace card: a 230px cap, dragged past it, then its run's status change
        {
          const homeDragged = await dragTo(page, HOME, homeOut, ARM);
          check(near(homeDragged.after && homeDragged.after.h, ARM), "workspace: the drag carries it past its 230px cap to 420px",
            `h ${homeDragged.from ? homeDragged.from.h : "(no press)"} -> ${homeDragged.after ? homeDragged.after.h : "(gone)"}`);
          const before = await armed(page, HOME, homeOut);
          const out = await finishTurn(page, HOME);
          if (!out) claimNothing("workspace status change", "the turn could not be found in state.jobs");
          else report("workspace status change", before, await measure(page, homeOut));
        }

        // ---- 10. workspace fold: the card's own head, twice
        await foldCycle(page, "workspace fold", HOME, homeOut);

        // ---- 11. the unattached list's wholesale rebuild - renderJobs rewrites #jobs from scratch
        {
          const before = await armed(page, HOME, homeOut);
          const rebuilt = await page.evaluate(() => {
            state.jobsListSig = ""; // the memo that makes the list only rewrite when a card's signature moved
            renderJobs();
            return true;
          });
          check(rebuilt, "workspace rebuild: the list was rewritten by renderJobs");
          report("workspace rebuild", before, await measure(page, homeOut));
        }

        // ---- 12. the store is per console: each keeps its own height through everything above
        {
          const row = await measure(page, rowOut);
          const home = await measure(page, homeOut);
          check(rowOut !== homeOut, "the two consoles are different turns", `${rowOut} / ${homeOut}`);
          check(near(row ? row.h : 0, ARM, 2) && near(home ? home.h : 0, ARM, 2), "each keeps its own 420px through every rebuild above",
            `row=${row ? row.h : "(none)"} home=${home ? home.h : "(none)"}`);
        }

        check(pageErrors.length === 0, "the page threw nothing", pageErrors.slice(0, 3).join(" | "));
      },
      { viewport: { width: 1440, height: 1000 } },
    );
  } finally {
    await panel.stop();
    await gateway.close();
    if (!KEEP) rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    else console.log(`sandbox kept: ${work}`);
  }

  const tail = notExercised ? `, ${notExercised} not exercised` : "";
  console.log(failures ? `RESULT: FAIL (${failures} of ${checks} checks${tail})` : `RESULT: PASS (${checks} checks${tail})`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
