#!/usr/bin/env node
// The approvals dock: a head that counts PENDING requests, records that can be cleared and age out, a click that
// takes the reader to the agent that asked, and a Keep / Unwind review of a write the panel allowed without asking.
//
//   node tools/verify-approvals-dock.mjs
//
// WHAT WAS WRONG (0.66.1). The dock's heading was fixed markup — `⚠ waiting on you` — whatever the dock held, so a
// single green `✓ remote write allowed always: git push …` record sat under it with no buttons, no way to dismiss
// it and no interaction at all: the box said a question was waiting when nothing was. The decided record lived in
// page state until a reload (`state.rwDecided`, trimmed to the last three, never aged), clicking the head or a card
// did nothing (only the 6px `▾` was wired), and a write the SETTING allowed (`remoteBranchPolicy: allow`, or a tree
// started to land) went through with no record on the board at all — the guard's own copy of the policy makes the
// hook return before it ever asks the panel, so the panel could not see it.
//
// NOW.
//   * the head COUNTS: `⚠ waiting on you` only while a request is pending, `✓ nothing pending` when none is, and a
//     decided record or a review never sits under the waiting label;
//   * decided records are receipts: a `✕` each, a `clear` on the group, and they age out after 90 s;
//   * clicking the head or a card unfolds the dock and jumps to the agent that asked, through the same
//     `jumpToAgent()` a row chip uses (unfolding its root, project and row first, so the card exists to jump to);
//     a write whose agent cannot be found says so in the card and in the banner, instead of doing nothing;
//   * nothing pending and no records => the dock hides, with no empty box left in the corner;
//   * an auto-allowed write comes back as a REVIEW card with Keep / Unwind. Unwind names exactly what it will do:
//     a remote branch delete is a delete and the click is its confirmation, and a write with no safe inverse is a
//     drafted message to the agent — the panel never runs an inverse of its own.
//
// WHAT IS DRIVEN, on a throwaway panel of this checkout (real server.js, temp config, its own port) in real
// Chromium, with the page's own EventSource kept live so the requests below are real POSTs the panel broadcasts:
//   * a parked remote write: the head reads waiting, the count chip says 1, the four choices are drawn
//   * clicking the head unfolds it and the card says no agent on this board owns the write
//   * Deny: the box goes, the head stops saying waiting and says nothing is pending, the record carries a ✕
//   * the ✕ empties the group and the dock hides; `clear` empties the group and the dock hides
//   * four decisions show three records (the trim), and a record ages out of its own account
//   * with an agent card on the board (a `jobs` frame for the write's own tree), clicking the head unfolds the dock,
//     scrolls the card into view and flashes it; a decided record jumps back to it the same way
//   * an auto-allowed write arrives as a review card: Keep dismisses it; the Unwind button names the exact remote
//     branch delete it would run; and for a write with no safe inverse the Unwind button drafts a message in the
//     agent's reply box and posts nothing
//
// BEFORE IT LANDED. Run this file on the branch's base (0.66.1): it fails on the head that still says waiting with
// nothing pending, on the absent ✕ / clear / review card, and on the click that does nothing — which is the defect.
//
// The browser half needs a Playwright install. Point the script at one with PANEL_PLAYWRIGHT_ROOT (a directory
// holding node_modules/playwright, or the package itself); without one it says BROWSER-HALF-NOT-RUN and exits 2
// rather than passing on a half that never ran. The reader's live panel is never touched.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { startPanel, waitFor } from "./panel-testkit.mjs";

const VIEWPORT = { width: 1440, height: 1000 };
const BRANCH = "wtgui/probe-27-dock";

let failures = 0;
let checks = 0;
const check = (cond, label, detail = "") => {
  checks += 1;
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const section = (name) => console.log(`\n-- ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The page keeps its real stream: every request below is a real POST, so the dock's own events are what paints it.
// The wrapper exists only so THIS file can also push a frame the panel would have to run an agent to produce.
const CAPTURE_STREAMS = () => {
  window.__es = [];
  const Real = window.EventSource;
  window.EventSource = function Patched(url) {
    const es = new Real(url);
    window.__es.push(es);
    return es;
  };
  window.EventSource.prototype = Real.prototype;
  window.EventSource.CONNECTING = Real.CONNECTING;
  window.EventSource.OPEN = Real.OPEN;
  window.EventSource.CLOSED = Real.CLOSED;
  window.__emit = (type, payload) => {
    const es = window.__es[0];
    if (!es) throw new Error("no live EventSource to dispatch on");
    es.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(payload) }));
    return true;
  };
};

const read = (page) =>
  page.evaluate(() => {
    const dock = document.getElementById("approvals");
    const head = document.getElementById("approval-head");
    const shown = Boolean(dock) && !dock.hidden && getComputedStyle(dock).display !== "none";
    const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
    const boxes = [...document.querySelectorAll("#approval-list .turn-approval[data-remote-write]")];
    return {
      shown,
      hidden: dock ? dock.hidden : null,
      folded: dock ? dock.classList.contains("is-folded") : null,
      quiet: dock ? dock.classList.contains("is-quiet") : null,
      head: text(head),
      chip: text(document.getElementById("approval-chips")),
      boxes: boxes.length,
      boxNotes: boxes.map((b) => text(b.querySelector("[data-rw-note]"))),
      approvals: document.querySelectorAll("#approval-list .approval[data-approval]").length,
      choices: document.querySelectorAll("#approval-list .ta-actions button[data-choice]").length,
      groups: [...document.querySelectorAll("#approval-list [data-rw-group]")].map((g) => ({
        kind: g.dataset.rwGroup,
        head: text(g.querySelector(".ap-group-head")),
        clear: Boolean(g.querySelector("[data-rw-clear]")),
      })),
      records: [...document.querySelectorAll("#approval-list [data-rw-record]")].map((r) => ({
        id: r.dataset.rwRecord,
        text: text(r.querySelector(".rw-record-text")),
        note: text(r.querySelector("[data-rw-note]")),
        dismiss: Boolean(r.querySelector("[data-rw-dismiss]")),
      })),
      reviews: [...document.querySelectorAll("#approval-list [data-rw-review]")].map((r) => ({
        id: r.dataset.rwReview,
        text: text(r),
        keep: Boolean(r.querySelector("[data-rw-review-keep]")),
        unwind: text(r.querySelector("[data-rw-review-unwind]")),
        note: text(r.querySelector("[data-rw-note]")),
      })),
    };
  });

const requestWrite = async (base, worktree, branch = BRANCH) => {
  const r = await fetch(`${base}/api/remote-write/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ worktree, branch, remote: "origin", refs: `refs/heads/${branch}`, remoteUrl: "probe" }),
  });
  const body = await r.json().catch(() => ({}));
  // A parked request answers `{allowed:false, id, deadline}`; an allowed one answers `{allowed:true}` with none.
  return { status: r.status, body, id: body.pending?.id || body.id || null };
};
const answerWrite = async (base, id, choice = "deny") => {
  const r = await fetch(`${base}/api/remote-write/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, choice, by: "reader" }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the approvals dock", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
    process.exit(2);
  }
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-approvals-dock-"));
  const panel = await startPanel({ dir, config: { assistant: { enabled: false }, fetchSeconds: -1 } });
  // A tree the panel has never scanned: the write asks about a path, not about a row, and no agent owns it.
  const tree = path.join(dir, "repos", "probe-tree").replace(/\\/g, "/");
  try {
    console.log(`sandbox: ${panel.base}`);
    await withBrowser(
      async ({ page, pageErrors }) => {
        const posted = [];
        page.on("request", (req) => {
          if (req.method() === "POST" && /\/api\/remote-write\/unwind$/.test(req.url())) posted.push(req.url());
        });
        await page.addInitScript(CAPTURE_STREAMS);
        await page.setViewportSize(VIEWPORT);
        await openPage(page, panel.base, { selector: "#health.ok" });
        await page.waitForSelector("#approvals", { state: "attached", timeout: 30_000 });
        await page.waitForFunction(() => Array.isArray(window.__es) && window.__es.length > 0, { timeout: 20_000 });

        // ---- 1. one pending write: the head counts it, the box offers the choices -----------------------------
        section("one pending request");
        const first = await requestWrite(panel.base, tree);
        check(first.status === 200 && Boolean(first.id), "the panel parked the write", JSON.stringify(first.body));
        const id1 = first.id;
        const parked = await waitFor(async () => (await read(page)).boxes === 1, { what: "the dock box", timeoutMs: 10_000 });
        const withOne = await read(page);
        check(parked && withOne.shown, "the dock is up with one pending request", `shown ${withOne.shown}`);
        check(/waiting/i.test(withOne.head), "the head says waiting", `head ${JSON.stringify(withOne.head)}`);
        check(withOne.chip === "1", "the chip counts 1 pending", `chip ${JSON.stringify(withOne.chip)}`);
        check(withOne.choices === 4, "the box draws the four choices", `buttons ${withOne.choices}`);
        check(!withOne.quiet, "the amber pending look is on", `quiet ${withOne.quiet}`);

        // ---- 2. clicking the HEAD unfolds it and says no agent owns the write ----------------------------------
        section("clicking the head");
        await page.evaluate(() => localStorage.setItem("wtgui.approvalsFolded", "1"));
        await page.evaluate(() => applyApprovalsFold());
        const foldedFirst = await read(page);
        check(foldedFirst.folded === true, "the dock starts folded for this case", `folded ${foldedFirst.folded}`);
        await page.click("#approval-dock-head");
        await sleep(300);
        const unfolded = await read(page);
        check(unfolded.folded === false, "clicking the head unfolds the dock", `folded ${unfolded.folded}`);
        check(
          unfolded.boxNotes.some((n) => /no agent/i.test(n)),
          "and the card says no agent on this board owns that write",
          JSON.stringify(unfolded.boxNotes),
        );
        await page.evaluate(() => localStorage.setItem("wtgui.approvalsFolded", "0"));

        // ---- 3. Deny: the head stops saying waiting, and the record carries a ✕ ------------------------------
        section("a decided record");
        await answerWrite(panel.base, id1, "deny");
        const decided = await waitFor(async () => (await read(page)).records.length === 1, { what: "the decided record", timeoutMs: 10_000 });
        const afterDeny = await read(page);
        check(decided, "the decided record is drawn", JSON.stringify(afterDeny.records));
        check(!/waiting/i.test(afterDeny.head), "the head does NOT say waiting with nothing pending", `head ${JSON.stringify(afterDeny.head)}`);
        check(!afterDeny.chip, "and the count chip is gone", `chip ${JSON.stringify(afterDeny.chip)}`);
        check(afterDeny.quiet, "the dock wears the quiet look", `quiet ${afterDeny.quiet}`);
        check(afterDeny.records[0]?.dismiss === true, "the record carries a ✕", JSON.stringify(afterDeny.records[0]));
        check(
          afterDeny.groups.some((g) => g.kind === "decided" && g.clear),
          "the decided group has its own label and a clear action",
          JSON.stringify(afterDeny.groups),
        );

        // ---- 4. the ✕ dismisses it and the dock hides ---------------------------------------------------------
        section("dismissing");
        await page.click("[data-rw-dismiss]");
        await sleep(250);
        const dismissed = await read(page);
        check(dismissed.records.length === 0, "the ✕ removes the record", JSON.stringify(dismissed.records));
        check(dismissed.shown === false && dismissed.hidden === true, "and the dock hides when nothing is left", `shown ${dismissed.shown} hidden ${dismissed.hidden}`);

        // ---- 5. clear the group, and the trim -----------------------------------------------------------------
        section("clear, and the last three");
        const ids = [];
        for (let i = 0; i < 4; i += 1) {
          const r = await requestWrite(panel.base, tree, `${BRANCH}-${i}`);
          ids.push(r.id);
          await waitFor(async () => (await read(page)).boxes >= 1, { what: `request ${i} to land`, timeoutMs: 10_000 });
          await answerWrite(panel.base, r.id, "deny");
          await waitFor(async () => (await read(page)).records.length >= Math.min(i + 1, 3), { what: `record ${i}`, timeoutMs: 10_000 });
        }
        const four = await read(page);
        check(four.records.length === 3, "four decisions show the last three records", `records ${four.records.length}`);
        await page.click("[data-rw-clear]");
        await sleep(250);
        const cleared = await read(page);
        check(cleared.records.length === 0, "clear empties the group", JSON.stringify(cleared.records));
        check(cleared.shown === false, "and the dock hides again", `shown ${cleared.shown}`);

        // ---- 6. a record ages out on its own ------------------------------------------------------------------
        section("ageing out");
        const aged = await requestWrite(panel.base, tree, `${BRANCH}-age`);
        await waitFor(async () => (await read(page)).boxes >= 1, { what: "the ageing request", timeoutMs: 10_000 });
        await answerWrite(panel.base, aged.id, "deny");
        await waitFor(async () => (await read(page)).records.length === 1, { what: "the ageing record", timeoutMs: 10_000 });
        const freshRecord = await read(page);
        check(freshRecord.records.length === 1, "the record is up at once", JSON.stringify(freshRecord.records));
        // The TTL is a clock, not a sleep: move the page's own Date.now past it and let its 1 s sweep run once.
        await page.evaluate(() => {
          window.__realNow = Date.now;
          const base = window.__realNow();
          Date.now = () => base + 91_000;
        });
        const agedOut = await waitFor(async () => (await read(page)).shown === false, { what: "the record to age out", timeoutMs: 5_000 });
        const afterTtl = await read(page);
        check(agedOut && afterTtl.records.length === 0, "a decided record ages out of its own account (90 s)", `shown ${afterTtl.shown} records ${afterTtl.records.length}`);
        await page.evaluate(() => {
          if (window.__realNow) Date.now = window.__realNow;
        });

        // ---- 7. the jump: an agent card on the board, and the decision goes back to it ------------------------
        section("clicking through to the agent");
        const thread = "probe-dock-thread";
        await page.evaluate(
          ({ thread: t, tree: w }) => {
            window.__card = {
              id: "probe-dock-job",
              thread: t,
              turn: 1,
              status: "stopped",
              prompt: "a probe agent in the dock gate's own tree",
              displayPrompt: "a probe agent in the dock gate's own tree",
              cwd: w,
              worktree: false,
              worktreePath: null,
              projectPath: null,
              ownerPath: w,
              branch: "wtgui/probe-27-dock",
              runId: null,
              startedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
              model: "probe",
              lines: [],
              artifacts: [],
              attachments: [],
              subagents: [],
            };
            window.__emit("jobs", { jobs: [window.__card] });
          },
          { thread, tree },
        );
        const cardUp = await waitFor(async () => page.evaluate((t) => Boolean(document.querySelector(`.job[data-thread="${t}"]`)), thread), {
          what: "the probe card",
          timeoutMs: 10_000,
        });
        check(cardUp, "a card for the write's own tree is on the board (Unattached)");
        const jumpReq = await requestWrite(panel.base, tree, `${BRANCH}-jump`);
        await waitFor(async () => (await read(page)).boxes >= 1, { what: "the jumping request", timeoutMs: 10_000 });
        await page.evaluate(() => localStorage.setItem("wtgui.approvalsFolded", "1"));
        await page.evaluate(() => applyApprovalsFold());
        await page.click("#approval-dock-head");
        const jumped = await waitFor(
          async () =>
            page.evaluate((t) => {
              const card = document.querySelector(`.job[data-thread="${t}"]`);
              if (!card) return false;
              const r = card.getBoundingClientRect();
              return card.classList.contains("jump") && r.top >= 0 && r.bottom <= window.innerHeight;
            }, thread),
          { what: "the card to be flashed and in view", timeoutMs: 6_000 },
        );
        const jumpState = await page.evaluate((t) => {
          const dock = document.getElementById("approvals");
          const card = document.querySelector(`.job[data-thread="${t}"]`);
          const r = card ? card.getBoundingClientRect() : null;
          return {
            folded: dock.classList.contains("is-folded"),
            flash: card ? card.classList.contains("jump") : null,
            top: r ? Math.round(r.top) : null,
            bottom: r ? Math.round(r.bottom) : null,
            focus: state.pendingFocus?.thread || null,
          };
        }, thread);
        check(jumped, "clicking the head unfolds the dock and lands on the asking agent, flashed and in view", JSON.stringify(jumpState));
        check(jumpState.folded === false, "the dock stayed unfolded for it", `folded ${jumpState.folded}`);
        check(jumpState.focus === thread, "and the page is holding the caret for that card", `pendingFocus ${jumpState.focus}`);

        // ---- 8. a decided record goes back to the same agent -------------------------------------------------
        section("a record jumps back");
        await answerWrite(panel.base, jumpReq.id, "deny");
        await waitFor(async () => (await read(page)).records.length === 1, { what: "the record to jump from", timeoutMs: 10_000 });
        await page.evaluate(() => window.scrollTo(0, 0));
        await sleep(150);
        await page.click("[data-rw-record]");
        const backAt = await waitFor(
          async () =>
            page.evaluate((t) => {
              const card = document.querySelector(`.job[data-thread="${t}"]`);
              if (!card) return false;
              const r = card.getBoundingClientRect();
              return r.top >= 0 && r.bottom <= window.innerHeight;
            }, thread),
          { what: "the agent back in view", timeoutMs: 6_000 },
        );
        const recordNote = await page.evaluate(() => (document.querySelector("[data-rw-record] [data-rw-note]") || {}).textContent || "");
        check(backAt, "a decided record jumps back to the agent it was about", recordNote ? `note ${JSON.stringify(recordNote)}` : "");
        await page.click("[data-rw-dismiss]");
        await sleep(200);

        // ---- 9. an auto-allowed write comes back as a review card --------------------------------------------
        section("the auto-allowed review");
        const reviewId = "rwv_probe_1";
        await page.evaluate(
          ({ id, w }) => {
            window.__emit("remote-write-review", {
              review: {
                id,
                kind: "push",
                state: "ran",
                confirmed: true,
                worktree: w,
                project: "",
                branch: "wtgui/probe-27-dock",
                remote: "origin",
                refs: "refs/heads/wtgui/probe-27-dock",
                sha: "0123456789abcdef",
                command: "git push origin wtgui/probe-27-dock",
                why: "the setting allows remote writes",
                at: Date.now(),
                unwind: {
                  type: "delete-branch",
                  label: "delete remote branch origin/wtgui/probe-27-dock",
                  command: "git push origin --delete wtgui/probe-27-dock",
                },
              },
            });
          },
          { id: reviewId, w: tree },
        );
        const reviewUp = await waitFor(async () => (await read(page)).reviews.length === 1, { what: "the review card", timeoutMs: 8_000 });
        const review = (await read(page)).reviews[0] || {};
        check(reviewUp, "an auto-allowed write is surfaced as a review card", JSON.stringify(review));
        check(Boolean(review.keep), "with Keep", `text ${JSON.stringify(review.text)}`);
        check(/--delete wtgui\/probe-27-dock/.test(review.text || ""), "and Unwind that names the exact remote branch delete", `unwind ${JSON.stringify(review.unwind)}`);
        check(/delete remote branch origin\/wtgui\/probe-27-dock/.test(review.unwind || ""), "the Unwind button itself names the branch", `unwind ${JSON.stringify(review.unwind)}`);
        check(/nothing pending/i.test((await read(page)).head), "the review sits under a head that is not claiming a wait", `head ${JSON.stringify((await read(page)).head)}`);
        await page.click("[data-rw-review-keep]");
        const kept = await waitFor(async () => (await read(page)).reviews.length === 0, { what: "Keep to dismiss the review", timeoutMs: 6_000 });
        check(kept, "Keep dismisses the review", JSON.stringify((await read(page)).reviews));

        // ---- 10. no safe inverse: a drafted message, never a command the panel runs --------------------------
        section("no safe inverse");
        await page.evaluate(
          ({ w, t }) => {
            window.__emit("remote-write-review", {
              review: {
                id: "rwv_probe_2",
                kind: "push",
                state: "ran",
                confirmed: true,
                worktree: w,
                project: "",
                branch: "main",
                remote: "origin",
                refs: "refs/heads/main",
                sha: "fedcba9876543210",
                command: "git push origin main",
                why: "this tree was started to land",
                at: Date.now(),
                agentThread: t,
                unwind: {
                  type: "message",
                  label: `message ${t}`,
                  text: "You were allowed to push main without being asked. Please check whether that push was intended and tell me what it carried.",
                },
              },
            });
          },
          { w: tree, t: thread },
        );
        const messageUp = await waitFor(async () => (await read(page)).reviews.length === 1, { what: "the message review", timeoutMs: 8_000 });
        check(messageUp, "the message review is on the dock", JSON.stringify((await read(page)).reviews));
        const msgReview = (await read(page)).reviews[0] || {};
        check(/message|draft/i.test(msgReview.unwind || ""), "a write with no safe inverse offers a draft message, not a command", `unwind ${JSON.stringify(msgReview.unwind)}`);
        await page.click("[data-rw-review-unwind]");
        await sleep(300);
        const drafted = await page.evaluate((t) => {
          const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(t)}"]`);
          return { text: box ? box.textContent.trim() : null, focused: Boolean(box) && document.activeElement === box };
        }, thread);
        check(/allowed to push main/.test(drafted.text || ""), "Unwind drafts that message in the agent's reply box", JSON.stringify(drafted));
        check(drafted.focused === true, "and leaves the caret in it, unsent", `focused ${drafted.focused}`);
        check(posted.length === 0, "no unwind POST was made — the panel ran nothing", JSON.stringify(posted));

        check(pageErrors.length === 0, "no uncaught page errors", pageErrors.join(" | "));
      },
      { viewport: VIEWPORT, deviceScaleFactor: 1 },
    );
  } catch (e) {
    failures += 1;
    console.log(`FAIL  the run itself threw  ${(e && e.stack) || e}`);
  } finally {
    await panel.stop();
    console.log(`\n${failures === 0 ? "OK" : "FAILED"}  ${checks - failures}/${checks} checks passed`);
    process.exit(failures === 0 ? 0 : 1);
  }
}

await main();
