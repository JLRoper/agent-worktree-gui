// HARNESS: LIVE GATE
// THE SENT DRAFT STAYS SENT: a reply the reader has sent leaves NOTHING behind for a repaint to hand back.
//
// Row 301, "the composer keeps the sent text after the turn lands ... sometimes": the draft has two stores in
// this page - `state.replyDrafts` (public/app.js) and the paste-chip mirror (public/board/paste-chips.js,
// `state.boxModels` + sessionStorage) - and the send used to clear the mirror only THROUGH a box node it could
// still see. A landing repaint is exactly when the box is rebuilt, so a send whose card was rebuilt, moved or
// folded away for the length of the POST left the mirror behind and the repaint drew the sent words, chip and
// all, back under the answer. A preset send (the queue's drain, Retry turn, Continue) failed the other way: it
// wiped the draft map of a box it had NOT cleared, so a plain unsent draft typed since died on the next repaint
// while a chipped one survived on the mirror alone.
//
// WHAT IS PROVED, IN A REAL CHROMIUM, AGAINST A SANDBOX PANEL OF THIS CHECKOUT
//
//   (1) a plain typed draft, sent from the card's own Send reply button: EMPTY after the send, EMPTY after a
//       forced repaint, EMPTY after a reload - and nothing left in the map, the mirror or sessionStorage;
//   (2) a chip-bearing (pasted) draft, the same three reads, plus the chip's own text dropped from
//       `state.pasteChips` (a sent paste has no claim on a megabyte for the life of the page);
//   (3) the owner chip's prefill, both shapes public/app.js and public/assistant.js write ('Regarding ...' with
//       no input event, and the task question with one): it LANDS in the box with the caret at the end, a repaint
//       keeps it while it is unsent, and after a send it is gone from the box, the map and the mirror;
//   (4) an UNSENT chip draft in another composer: the same repaint brings it back with its chips;
//   (5) a preset send with the reader's newer, blurred draft in the box: the draft and its repaint survive (the
//       old order wiped the map and the following repaint emptied the box - the loss that made a chipped draft
//       look lucky);
//   (6) a send whose card is OUT OF THE DOCUMENT when the response lands: the mirror is cleared by thread
//       (public/board/paste-chips.js `forgetReplyDraft`), so the rebuild cannot replay the sent words;
//   (7) the source contract: ONE operation (`clearSentDraft`) covers all three stores, the send calls it once
//       after the post is accepted and BEFORE the response's repaint, and every send path (reply, queue, steer)
//       goes through it.
//
//   node tools/verify-reply-draft-send.mjs
//
// The browser half needs a Playwright install (tools/browser.mjs finds one; BROWSER-HALF-NOT-RUN + exit 2 when
// it cannot). Every POST is stubbed and recorded: no gateway is reached, no run is started.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installFakeEventSource, loadPlaywright } from "./browser.mjs";
import { readSource, waitFor } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const THREAD_A = "wtgui-probe-draft-a-4110aa";
const THREAD_B = "wtgui-probe-draft-b-4110bb";

let failures = 0;
let checks = 0;
const brief = (v) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s == null) return String(s);
  return s.length <= 90 ? s : `${s.slice(0, 60)}...(${s.length} chars)`;
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${brief(extra)}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? `: ${brief(extra)}` : ""}`);
  }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${brief(got)} want ${brief(want)}`);
const note = (text) => console.log(`      ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const PASTE = Array.from({ length: 40 }, (_, i) => `pasted line ${i + 1} of the block the reader pasted`).join("\n");
const REGARDING = "Regarding agent-worktree-gui read-queue-row-301-first wtgui/read-queue-row-301-first-123014: ";
const QUESTION = "I have a question about #301 the composer keeps the sent text... ";

let dir = null;

async function startSandbox() {
  dir = mkdtempSync(path.join(tmpdir(), "wtgui-reply-draft-"));
  const scanRoot = path.join(dir, "scan-root");
  const home = path.join(dir, "hermes-home");
  const configDir = path.join(dir, "panel");
  const cwdDir = path.join(dir, "panel-cwd");
  for (const d of [scanRoot, home, configDir, cwdDir, path.join(configDir, "logs")]) mkdirSync(d, { recursive: true });
  const port = await freePort();
  const configPath = path.join(configDir, "config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        port,
        host: "127.0.0.1",
        scanRoots: [scanRoot],
        defaultCwd: cwdDir,
        jobsFile: path.join(configDir, "logs", "jobs.json"),
        assistantFile: path.join(configDir, "logs", "assistant.json"),
        projectsCacheFile: path.join(configDir, "logs", "projects.json"),
        treeNamesFile: path.join(configDir, "logs", "tree-names.json"),
        // Nothing this script drives may reach a gateway: every POST the page makes is stubbed below, and this is
        // the belt to that brace.
        apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
        assistant: { enabled: false, seconds: 3600, maxWakesPerHour: 0 },
        refreshSeconds: 3600,
        worktreeSeconds: 3600,
        midSeconds: 3600,
        dormantSeconds: 3600,
        slowSeconds: 3600,
        fetchSeconds: 3600,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const base = `http://127.0.0.1:${port}`;
  // The panel is the repo's own server.js, run from this checkout, so the page under test is this tree's code.
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: home, PANEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const log = [];
  child.stdout.on("data", (d) => log.push(...String(d).split(/\r?\n/).filter(Boolean)));
  child.stderr.on("data", (d) => log.push(...String(d).split(/\r?\n/).filter(Boolean)));
  const up = await waitFor(async () => (await fetch(`${base}/api/health`)).ok, { timeoutMs: 40_000, what: "the sandbox panel to answer /api/health" });
  if (!up) {
    child.kill();
    throw new Error(`the sandbox panel never came up on ${base}\n${log.slice(-15).join("\n")}`);
  }
  return { base, child };
}

async function stopSandbox(child) {
  if (!child) return;
  const done = new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill();
    setTimeout(resolve, 8000).unref?.();
  });
  await done;
}

// The page-side probe: two cards in the page's own state, rendered by the shipped renderJobs; every box read
// through readBox; every POST stubbed and recorded. Registered before the page navigates.
const probeScript = ({ threadA, threadB }) => {
  const realFetch = window.fetch.bind(window);
  const probe = { posts: [], confirm: false, done: null };
  window.__probe = probe;
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  const chips = () => window.WMApp.board.pasteChips;
  const boxOf = (thread) => document.querySelector(`.reply-box[data-reply="${thread}"]`);
  probe.read = (thread) => chips().readBox(boxOf(thread));
  probe.chips = (thread) => document.querySelectorAll(`.reply-box[data-reply="${thread}"] .paste-chip`).length;
  probe.stores = (thread) => ({
    draft: state.replyDrafts[thread] || "",
    box: chips().readBox(boxOf(thread)),
    modelKeys: [...state.boxModels.keys()],
    chipsInState: [...state.pasteChips.keys()],
    persisted: sessionStorage.getItem("wtgui.chipDrafts") || "",
  });
  probe.focus = (thread) => {
    const box = boxOf(thread);
    if (!box) return false;
    box.focus();
    return true;
  };
  probe.blur = () => document.activeElement?.blur?.();
  probe.caretAtEnd = (thread) => {
    const box = boxOf(thread);
    if (!box) return false;
    return chips().caretOffset(box) === chips().readBox(box).length;
  };
  probe.paste = (thread, payload) => {
    const box = boxOf(thread);
    if (!box) return false;
    box.focus();
    const dt = new DataTransfer();
    dt.setData("text/plain", payload);
    let ev = null;
    try {
      ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
    } catch {
      ev = null;
    }
    if (!ev || ev.clipboardData !== dt) {
      ev = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "clipboardData", { value: dt });
    }
    box.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  // The two prefill shapes the owner chip writes, with the writer each one uses:
  //   public/app.js        `openRegarding`      -> writeBox(text) + focus + caret at the end (no input event)
  //   public/assistant.js  `openQuestionAbout`  -> writeBox(text) + an `input` event (so it becomes a draft)
  probe.prefill = (thread, text, asDraft) => {
    const box = boxOf(thread);
    if (!box) return false;
    chips().writeBox(box, text);
    if (asDraft) box.dispatchEvent(new Event("input", { bubbles: true }));
    box.focus({ preventScroll: true });
    chips().setCaretOffset(box, chips().readBox(box).length);
    return chips().readBox(box);
  };
  // Fire and DO NOT await: a send is a POST the page is holding open, and what a repaint does while that is in
  // flight is half of what this script measures.
  probe.sendPreset = (thread, text) => {
    probe.done = null;
    window.sendReply(thread, text).then((ok) => {
      probe.done = ok;
    });
  };
  probe.detach = (thread) => {
    document.querySelector(`.job[data-thread="${thread}"]`)?.remove();
    return !boxOf(thread);
  };
  const job = (thread, id) => ({
    id,
    thread,
    turn: 1,
    status: "done",
    prompt: "the turn before the send",
    displayPrompt: "the turn before the send",
    cwd: null,
    worktree: false,
    runId: null,
    startedAt: new Date(Date.now() - 90_000).toISOString(),
    endedAt: new Date(Date.now() - 30_000).toISOString(),
    model: "probe/model",
    lines: [],
    artifacts: [],
    attachments: [],
    subagents: [],
  });
  // `keep` draws a card WITHOUT resetting the draft stores: that is the reload's own path (sessionStorage and
  // state survive, the card is drawn fresh and restoreReplyDraft/restorePersistedBox decide what comes back).
  probe.card = (thread, keep = false) => {
    document.activeElement?.blur?.();
    // One done turn for this thread and NOTHING else: a stubbed send leaves a "running" turn behind, and that
    // turn would replace the card's Send reply button with Steer turn for every later case.
    for (const [id, j] of [...state.jobs]) if ((j.thread || j.id) === thread) state.jobs.delete(id);
    if (!keep) {
      state.replyDrafts[thread] = "";
      state.boxModels.delete(`reply:${thread}`);
    }
    document.querySelector(`.job[data-thread="${thread}"]`)?.remove();
    state.jobs.set(`probe-${thread}`, job(thread, `probe-${thread}`));
    renderJobs();
    return Boolean(boxOf(thread));
  };
  probe.repaint = () => {
    renderJobs();
    return true;
  };
  probe.cards = () => [threadA, threadB].map((t) => probe.card(t, true));
  const replyJob = (thread, text, n) => ({
    id: `probe-reply-${n}`,
    thread,
    turn: 9,
    prompt: text,
    displayPrompt: text,
    status: "running",
    startedAt: new Date().toISOString(),
    cwd: null,
    worktree: false,
    lines: [],
    artifacts: [],
    attachments: [],
    subagents: [],
  });
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = String((opts && opts.method) || "GET").toUpperCase();
    if (method !== "POST") {
      if (u.includes("/api/state")) return json({ ...(await realFetch(url, opts).then((r) => r.json())), jobs: [...state.jobs.values()] });
      return realFetch(url, opts);
    }
    let body = null;
    try {
      body = opts && opts.body ? JSON.parse(String(opts.body)) : null;
    } catch {
      body = null;
    }
    probe.posts.push({ url: u, body });
    if (probe.confirm) await new Promise((r) => setTimeout(r, probe.confirm));
    if (u.includes("/api/agents/reply")) return json({ job: replyJob((body && body.thread) || threadA, (body && body.text) || "", probe.posts.length) });
    return json({ ok: true });
  };
};

async function browserPhase(pw, base) {
  const pageErrors = [];
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await installFakeEventSource(context);
    await context.addInitScript(probeScript, { threadA: THREAD_A, threadB: THREAD_B });
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
    page.on("console", (m) => {
      if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
    });
    await page.goto(base, { waitUntil: "domcontentloaded" });
    const ready = await page
      .waitForFunction(
        () => typeof window.renderJobs === "function" && typeof window.__probe === "object" && typeof window.WMApp?.board?.pasteChips?.readBox === "function",
        null,
        { timeout: 30_000 },
      )
      .then(() => true)
      .catch(() => false);
    ok("browser: the page is loaded, with the draft contract installed", ready);
    if (!ready) return;
    // The two names the fix is: measured separately from the page being up, so a run against a tree that does not
    // carry them still drives every behaviour below and FAILS there instead of skipping.
    ok("browser: ONE clear is installed for the send", await page.evaluate(() => typeof window.clearSentDraft === "function"));
    ok("browser: the paste-chip module publishes the send's own mirror clear", await page.evaluate(() => typeof window.WMApp.board.pasteChips.forgetReplyDraft === "function"));

    const selA = `.job[data-thread="${THREAD_A}"] .reply-box`;
    const readA = () => page.evaluate((t) => window.__probe.read(t), THREAD_A);
    const readB = () => page.evaluate((t) => window.__probe.read(t), THREAD_B);
    const storeA = () => page.evaluate((t) => window.__probe.stores(t), THREAD_A);
    const storeB = () => page.evaluate((t) => window.__probe.stores(t), THREAD_B);
    const card = async (thread, keep = false) => {
      const made = await page.evaluate(([t, k]) => window.__probe.card(t, k), [thread, keep]);
      await page.waitForTimeout(200);
      return made;
    };
    const repaint = async () => {
      await page.evaluate(() => window.__probe.repaint());
      await page.waitForTimeout(220);
    };
    const typeIn = async (thread, text) => {
      await page.evaluate((t) => window.__probe.focus(t), thread);
      await page.keyboard.type(text);
      await page.waitForTimeout(150);
    };
    const paste = async (thread, text) => {
      await page.evaluate(([t, p]) => window.__probe.paste(t, p), [thread, text]);
      await page.waitForTimeout(220);
    };
    const blur = () => page.evaluate(() => window.__probe.blur());
    const clickSend = async (thread) => {
      await page.click(`.btn-reply[data-thread="${thread}"]`);
      await page.waitForTimeout(450);
    };
    const pasti = async () => page.evaluate(() => window.__probe.posts.map((p) => p.body && p.body.text));
    const resetPosts = () => page.evaluate(() => {
      window.__probe.posts.length = 0;
    });

    // ============ (1) a plain typed draft, sent from the card's own Send reply button ============
    console.log("\n== (1) a plain typed draft, real Send reply press ==");
    ok("the card renders with its reply box", await card(THREAD_A));
    await typeIn(THREAD_A, "plain typed draft, please run the thing");
    eq("(1) the box holds the draft before the press", await readA(), "plain typed draft, please run the thing");
    await clickSend(THREAD_A);
    eq("(1) what was POSTed is the draft", (await pasti()).slice(-1)[0], "plain typed draft, please run the thing");
    eq("(1) the box is EMPTY after the send", await readA(), "");
    await repaint();
    eq("(1) and EMPTY after a forced repaint", await readA(), "");
    let s = await storeA();
    eq("(1) no draft in the map", s.draft, "");
    eq("(1) nothing in the paste-chip mirror", s.modelKeys, []);
    eq("(1) nothing in sessionStorage", s.persisted, "");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.renderJobs === "function" && window.__probe, null, { timeout: 30_000 });
    await page.waitForTimeout(500);
    await card(THREAD_A, true);
    eq("(1) and EMPTY after the page reloads", await readA(), "");

    // ============ (2) a chip-bearing (pasted) draft ============
    console.log("\n== (2) a 40-line paste collapsed into a chip, then sent ==");
    ok("the card is back", await card(THREAD_A));
    await paste(THREAD_A, PASTE);
    await typeIn(THREAD_A, " and the prose around the chip");
    eq("(2) one chip in the box", await page.evaluate((t) => window.__probe.chips(t), THREAD_A), 1);
    const chipIdsBefore = (await storeA()).chipsInState;
    ok("(2) the chip's text is held in state before the send", chipIdsBefore.length === 1, chipIdsBefore);
    await clickSend(THREAD_A);
    eq("(2) what was POSTed carries the pasted block in place", (await pasti()).slice(-1)[0], `${PASTE} and the prose around the chip`);
    eq("(2) the box is EMPTY after the send", await readA(), "");
    await repaint();
    eq("(2) and EMPTY after a forced repaint", await readA(), "");
    eq("(2) and the chip is gone from the box", await page.evaluate((t) => window.__probe.chips(t), THREAD_A), 0);
    s = await storeA();
    eq("(2) no draft in the map", s.draft, "");
    eq("(2) no model for the thread", s.modelKeys, []);
    eq("(2) the sent paste is no longer held in state", s.chipsInState, []);
    eq("(2) nothing in sessionStorage", s.persisted, "");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.renderJobs === "function" && window.__probe, null, { timeout: 30_000 });
    await page.waitForTimeout(500);
    await card(THREAD_A, true);
    eq("(2) and EMPTY after the page reloads", await readA(), "");
    eq("(2) the reload brought back no chip", await page.evaluate((t) => window.__probe.chips(t), THREAD_A), 0);

    // ============ (3) the owner chip's prefill, both shapes ============
    console.log("\n== (3) the owner chip's prefill lands, survives unsent, and is gone after a send ==");
    ok("the card is back", await card(THREAD_A));
    await resetPosts();
    eq("(3) 'Regarding ...' lands in the box", await page.evaluate(([t, x]) => window.__probe.prefill(t, x, false), [THREAD_A, REGARDING]), REGARDING);
    ok("(3) with the caret at the end of it", await page.evaluate((t) => window.__probe.caretAtEnd(t), THREAD_A));
    await clickSend(THREAD_A);
    eq("(3) the prefill is what was POSTed", (await pasti()).slice(-1)[0], REGARDING.trim());
    await repaint();
    eq("(3) the box is EMPTY after the send and a repaint", await readA(), "");
    eq("(3) nothing left in the mirror", (await storeA()).modelKeys, []);
    ok("the card is back", await card(THREAD_A));
    await resetPosts();
    eq("(3) the task question lands in the box", await page.evaluate(([t, x]) => window.__probe.prefill(t, x, true), [THREAD_A, QUESTION]), QUESTION);
    await repaint();
    eq("(3) an UNSENT prefill still comes back after a repaint", await readA(), QUESTION);
    await clickSend(THREAD_A);
    eq("(3) the task question is what was POSTed", (await pasti()).slice(-1)[0], QUESTION.trim());
    await repaint();
    eq("(3) and it is EMPTY after the send and a repaint", await readA(), "");
    eq("(3) nothing left in the map", (await storeA()).draft, "");

    // ============ (4) an unsent chip draft in ANOTHER composer ============
    console.log("\n== (4) an unsent draft in a different composer survives the same repaint ==");
    ok("thread A's card is back", await card(THREAD_A));
    ok("thread B's card is up too", await card(THREAD_B));
    await paste(THREAD_B, PASTE);
    await typeIn(THREAD_B, " and B's own prose");
    eq("(4) B's box holds the draft with its chip", await readB(), `${PASTE} and B's own prose`);
    await typeIn(THREAD_A, "a reply from A");
    await clickSend(THREAD_A);
    await repaint();
    eq("(4) A is empty", await readA(), "");
    eq("(4) B still holds its unsent draft after the same repaint", await readB(), `${PASTE} and B's own prose`);
    eq("(4) and B still has its chip", await page.evaluate((t) => window.__probe.chips(t), THREAD_B), 1);
    ok("(4) B's draft is still the panel's draft", (await storeB()).draft === `${PASTE} and B's own prose`);
    ok("(4) B's mirror entry is untouched", (await storeB()).modelKeys.includes(`reply:${THREAD_B}`), (await storeB()).modelKeys);

    // ============ (5) a preset send must not wipe the reader's newer draft ============
    console.log("\n== (5) a preset send (the queue's drain / Retry / Continue) with a newer draft in the box ==");
    ok("thread A's card is back", await card(THREAD_A));
    await typeIn(THREAD_A, "the NEXT message, typed while the held reply goes out");
    await blur();
    const newer = "the NEXT message, typed while the held reply goes out";
    eq("(5) the newer draft is in the box", await readA(), newer);
    await page.evaluate((t) => window.__probe.sendPreset(t, "the held reply that was queued"), THREAD_A);
    await page.waitForTimeout(500);
    await repaint();
    eq("(5) the newer, unsent draft survives the repaint", await readA(), newer);
    eq("(5) and it is still the panel's draft", (await storeA()).draft, newer);
    eq("(5) the held reply was the one sent", (await pasti()).slice(-1)[0], "the held reply that was queued");
    // the same shape with a chip in the newer draft
    ok("thread A's card is back", await card(THREAD_A));
    await paste(THREAD_A, PASTE);
    await typeIn(THREAD_A, " B's style: a chip in the newer draft");
    await blur();
    await page.evaluate((t) => window.__probe.sendPreset(t, "another held reply"), THREAD_A);
    await page.waitForTimeout(500);
    await repaint();
    eq("(5) a chipped newer draft survives too", await readA(), `${PASTE} B's style: a chip in the newer draft`);
    eq("(5) with its chip", await page.evaluate((t) => window.__probe.chips(t), THREAD_A), 1);

    // ============ (6) a send whose card is NOT in the document when the response lands ============
    console.log("\n== (6) the send's card is out of the document while the POST is open ==");
    ok("thread A's card is back", await card(THREAD_A));
    await paste(THREAD_A, PASTE);
    await typeIn(THREAD_A, " and the reader's own prose");
    await blur();
    const sentWithChip = `${PASTE} and the reader's own prose`;
    eq("(6) the box holds the text that will go out, with its chip", await readA(), sentWithChip);
    await page.evaluate(() => {
      window.__probe.confirm = 700;
    });
    await page.evaluate(([t, text]) => window.__probe.sendPreset(t, text), [THREAD_A, sentWithChip]);
    await page.waitForTimeout(150);
    ok("(6) the card is detached for the length of the POST", await page.evaluate((t) => window.__probe.detach(t), THREAD_A));
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      window.__probe.confirm = false;
    });
    // THE MOMENT THE READER SEES: the response has landed and the box has been rebuilt from the mirror. This is
    // the row's screenshot - the answer on screen above a composer holding the words that were just sent.
    const landed = await storeA();
    eq("(6) the sent text is not in the rebuilt box when the response lands", landed.box, "");
    eq("(6) and no model is left for the thread at that moment", landed.modelKeys.includes(`reply:${THREAD_A}`), false);
    ok("(6) and none for it in sessionStorage at that moment", !landed.persisted.includes(`reply:${THREAD_A}`), landed.persisted.length);
    await repaint();
    eq("(6) the sent text is not back in the box after the rebuild", await readA(), "");
    s = await storeA();
    eq("(6) no model left for the thread", s.modelKeys.includes(`reply:${THREAD_A}`), false);
    ok("(6) and none for it in sessionStorage", !s.persisted.includes(`reply:${THREAD_A}`), s.persisted.length);
    ok("(6) the send itself was accepted", (await page.evaluate(() => window.__probe.done)) === true);

    // ============ (7) the source contract ============
    console.log("\n== (7) one operation, ordered after the post and before the repaint ==");
    const appSrc = readSource("public/app.js");
    const chipsSrc = readSource("public/board/paste-chips.js");
    const sendBody = appSrc.slice(appSrc.indexOf("async function sendReply("), appSrc.indexOf("async function steerTurn("));
    eq("(7) one definition of the clear", (appSrc.match(/function clearSentDraft\(/g) || []).length, 1);
    ok("(7) it clears the map, the mirror and the DOM", /state\.replyDrafts\[bound\] = ""/.test(appSrc) && /forgetReplyDraft\(bound\)/.test(appSrc) && /writeBox\(el, ""\)/.test(appSrc));
    ok("(7) the send calls it exactly once", (sendBody.match(/clearSentDraft\(/g) || []).length === 1, sendBody.match(/clearSentDraft\(/g)?.length);
    ok("(7) after the post is accepted", sendBody.indexOf("if (!r.ok) throw") >= 0 && sendBody.indexOf("clearSentDraft(") > sendBody.indexOf("if (!r.ok) throw"));
    ok("(7) and before the response's repaint", sendBody.indexOf("clearSentDraft(") > 0 && sendBody.indexOf("clearSentDraft(") < sendBody.indexOf("updateJob(d.job"));
    ok("(7) the queue press and both steer paths use the same one", (appSrc.match(/clearSentDraft\(/g) || []).length >= 4, (appSrc.match(/clearSentDraft\(/g) || []).length);
    ok("(7) the mirror clear is keyed on the thread, not a node", /function forgetReplyDraft\(thread\)/.test(chipsSrc) && /const key = `reply:\$\{t\}`/.test(chipsSrc));

    // ============ page health ============
    console.log("\n== (8) the page's own console stayed quiet ==");
    eq("(8) no page errors", pageErrors, []);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---- boot ----------------------------------------------------------------------------------------------
console.log("THE SENT DRAFT STAYS SENT - row 301's composer draft, sent and re-read");
const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-HALF-NOT-RUN: no Playwright install found (see tools/browser.mjs)");
  process.exitCode = 2;
} else {
  let child = null;
  try {
    const sandbox = await startSandbox();
    child = sandbox.child;
    note(`sandbox panel on ${sandbox.base}`);
    await browserPhase(pw, sandbox.base);
  } catch (e) {
    failures += 1;
    console.log(`THREW  ${String(e && e.stack ? e.stack : e)}`);
  } finally {
    await stopSandbox(child);
    await sleep(200);
    console.log(`\n${checks - failures}/${checks} checks passed`);
    process.exitCode = failures ? 1 : 0;
  }
}
