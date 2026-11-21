// HARNESS: LIVE GATE
// The auto-allowed write review card: ONE summary line, its actions, and everything else behind Details.
//
//   node tools/verify-rw-review-compact.mjs [--root <export>] [--shots <dir>]
//
// WHAT WAS WRONG (1.146.0). `remoteWriteReviewHtml()` drew the same branch four times as a ref down a 480px dock:
// in the command block, in the policy line, in the Unwind button's label, in the unwind prose under it - and a
// fifth time as the bare slug in the command's own "from <tree>" tail. A 90-second receipt measured 320px tall
// and 599 visible characters, and stated one fact over and over, so the action, the sha and the time were the
// parts a reader had to hunt for. The reader's report is the card at 1440 with a 54-character branch in every
// one of those places.
//
// NOW. The card is a summary line and two controls:
//   * the line carries the ACTION, the branch, the repo, the short sha and when (".rw-review-head");
//   * the branch is the only item allowed to shrink (repo, sha and when stay whole), and the full text with the
//     exact clock is the line's title;
//   * Keep is the full-width green bar and Unwind the red bar under it, both visible, labels "Keep" / "Unwind" -
//     the Unwind label no longer repeats the branch;
//   * the full command, the worktree path, the allow-policy and what Unwind runs sit in a closed `<details>`;
//     `summary`/`details` are in the dock click's skip list, so the disclosure owns the click instead of the
//     jump to the agent (whose preventDefault() would have swallowed the toggle).
//
// WHAT IS DRIVEN, on a sandbox panel of the checkout being measured (real server.js, its own port and store,
// assistant off) in real Chromium at the reader's 1440 window, with the page's own EventSource kept live so the
// review arrives through the shipped `remote-write-review` event:
//   * the summary is ONE line (height, scrollHeight vs clientHeight) and names action, branch, repo, sha and when;
//   * the branch appears exactly once in the card's visible text, the card's whole visible text is short, and the
//     old unwind prose element is gone;
//   * Keep and Unwind are drawn, visible and hit-testable, and Unwind's label is the word alone;
//   * Details starts closed, opens on a press (with no jump to an agent), carries the full command, the tree, the
//     allow-policy and the exact delete, and closes again on a second press;
//   * the keyboard path: Tab from Unwind reaches the Details line, a focus ring is painted, Enter opens it and
//     Space closes it;
//   * Keep still posts its decision for its own id;
//   * a screenshot per state at 1440 under --shots.
//
// BEFORE IT LANDED. Give it the base with --root: on origin/main the head reads "remote write allowed without
// asking", the branch is on the visible card 4 times, there is no Details element, the Unwind label repeats the
// branch, and the visible text is 599 characters against 124 - so the summary, label, disclosure and wordiness
// checks fail and the run exits 1. Those are the before numbers.
//
// The browser half needs a Playwright install. Point the script at one with PANEL_PLAYWRIGHT_ROOT (a directory
// holding node_modules/playwright, or the package itself); without one it says BROWSER-HALF-NOT-RUN and exits 2
// rather than passing on a half that never ran. The reader's live panel is never touched.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
// `--root` boots a `git archive` of another build: the kit and the server come from THAT tree, so the base's own
// public/ is what the page paints and the comparison is between two builds, not two fixtures.
const TREE_ROOT = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SHOTS = path.resolve(opt("--shots", path.join(tmpdir(), "wtgui-rw-compact-shots")));
const WIDTH = 1440;
const REPO = "agent-worktree-gui";
const BRANCH = "wtgui/the-worktree-row-name-carries-two-review-4c9db3";
const WORKTREE = `/repo/${REPO}/.worktrees/the-worktree-row-name-carries-two-review-4c9db3`;
const SHA = "07356b4c9d1e2f3a4b5c6d7e8f9012345678abcd";
const ID = "rwv_compact";

let checks = 0;
let failures = 0;
function check(ok, label, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}
const section = (name) => console.log(`\n-- ${name}`);
const note = (text) => console.log(`      ${text}`);

// The page keeps its REAL stream (the review below arrives through the shipped event), and the wrapper only lets
// this file push a frame the panel would otherwise need an agent to produce.
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

const REVIEW = {
  review: {
    id: ID,
    kind: "push",
    state: "ran",
    confirmed: true,
    worktree: WORKTREE,
    project: REPO,
    branch: BRANCH,
    remote: "origin",
    refs: `refs/heads/${BRANCH}`,
    sha: SHA,
    command: `git push origin ${BRANCH} - from ${WORKTREE} (allowed without asking)`,
    why: "the setting allows remote writes",
    at: Date.now(),
    unwind: {
      type: "delete-branch",
      label: `delete remote branch origin/${BRANCH}`,
      command: `git push origin --delete ${BRANCH}`,
    },
  },
};

const readCard = (page, id) =>
  page.evaluate((rid) => {
    const card = [...document.querySelectorAll("#approval-list [data-rw-review]")].find((c) => c.dataset.rwReview === rid);
    if (!card) return null;
    const q = (sel) => card.querySelector(sel);
    const head = q(".rw-review-head");
    const line = q(".rw-review-line");
    const keep = q("[data-rw-review-keep]");
    const unwind = q("[data-rw-review-unwind]");
    const details = q(".rw-review-details");
    const sum = q(".rw-review-sum");
    const body = q(".rw-review-body");
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { w: r.width, h: r.height, top: r.top, bottom: r.bottom, display: cs.display, outline: cs.outlineStyle, outlineWidth: cs.outlineWidth };
    };
    // innerText is what PAINTS: a closed <details> lays its body out, but that text is not in innerText.
    const shown = (el) => (el ? el.innerText.replace(/\s+/g, " ").trim() : "");
    const banner = document.getElementById("banner");
    return {
      card: { ...box(card), text: shown(card), chars: shown(card).length },
      head: head ? { ...box(head), text: shown(head), title: head.getAttribute("title") || "", scrollH: head.scrollHeight, clientH: head.clientHeight } : null,
      line: line ? { ...box(line), text: shown(line), scrollH: line.scrollHeight, clientH: line.clientHeight } : null,
      keep: keep ? { ...box(keep), text: shown(keep) } : null,
      unwind: unwind ? { ...box(unwind), text: shown(unwind), title: unwind.getAttribute("title") || "" } : null,
      details: details ? { ...box(details), open: details.open } : null,
      sum: sum ? { ...box(sum), text: shown(sum) } : null,
      body: body ? { text: shown(body), keys: [...body.querySelectorAll(".rw-detail-key")].map((k) => shown(k)) } : null,
      oldProse: Boolean(q("[data-rw-note]")),
      jumpNote: Boolean(q("[data-rw-jump-note]")),
      banner: banner ? shown(banner) : "",
      focus: document.activeElement ? { cls: String(document.activeElement.className || ""), tag: document.activeElement.tagName } : null,
    };
  }, id);

const count = (hay, needle) => String(hay).split(needle).length - 1;

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the review card's one summary line", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
    process.exit(2);
  }
  mkdirSync(SHOTS, { recursive: true });
  const { startPanel, waitFor } = await import(pathToFileURL(path.join(TREE_ROOT, "tools", "panel-testkit.mjs")).href);
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-rw-compact-"));
  const panel = await startPanel({ dir, root: TREE_ROOT, config: { assistant: { enabled: false }, fetchSeconds: -1 } });
  try {
    console.log(`sandbox: ${panel.base}  root: ${TREE_ROOT}  viewport: ${WIDTH}`);
    await withBrowser(
      async ({ page, pageErrors }) => {
        const posted = [];
        page.on("request", (req) => {
          if (req.method() !== "POST") return;
          if (/\/api\/remote-write\/(review|unwind)$/.test(req.url())) posted.push({ url: req.url(), body: req.postData() || "" });
        });
        await page.addInitScript(CAPTURE_STREAMS);
        await page.setViewportSize({ width: WIDTH, height: 1000 });
        await openPage(page, panel.base, { selector: "#health.ok" });
        await page.waitForSelector("#approvals", { state: "attached", timeout: 30_000 });
        await page.waitForFunction(() => Array.isArray(window.__es) && window.__es.length > 0, { timeout: 20_000 });

        // ---- 1. the card as the reader meets it -------------------------------------------------------------
        section(`the card at ${WIDTH}`);
        await page.evaluate((payload) => window.__emit("remote-write-review", payload), REVIEW);
        await waitFor(async () => Boolean(await readCard(page, ID)), { what: "the review card", timeoutMs: 10_000 });
        const card = await readCard(page, ID);
        check(Boolean(card.head), "the card opens with a summary line", card.head ? card.head.text : "no head");
        check(/^✓ pushed\b/.test(card.head.text), "that leads with the action", card.head.text);
        check(card.head.text.includes(BRANCH), "names the branch", card.head.text);
        check(card.head.text.includes(REPO), "the repo it was pushed from", card.head.text);
        check(card.head.text.includes(SHA.slice(0, 7)), "the short sha", card.head.text);
        check(/just now|\d+m ago/.test(card.head.text), "and when it happened", card.head.text);
        check(Boolean(card.line) && card.line.h <= 20 && card.line.scrollH <= card.line.clientH + 1, "the action and the branch are ONE line", `height ${(card.line ? card.line.h : 0).toFixed(1)}px`);
        check(card.head.h <= 40, "the summary holds repo, sha and when on one muted line under it at most", `head ${card.head.h.toFixed(1)}px (two lines: ${(card.head.h - (card.line ? card.line.h : 0)).toFixed(1)}px of meta)`);
        check(card.head.title.includes(BRANCH), "the full branch and clock ride the line's title", card.head.title);
        check(count(card.card.text, BRANCH) === 1, "the branch is stated exactly ONCE on the visible card", `${count(card.card.text, BRANCH)} x ${BRANCH}`);
        check(card.card.chars <= 200, "the visible card is a summary, not a record dump", `${card.card.chars} visible chars`);
        note(`card ${card.card.h.toFixed(1)}px tall, ${card.card.chars} visible chars, the branch ${count(card.card.text, BRANCH)}x`);
        check(Boolean(card.keep) && card.keep.h >= 15 && card.keep.w > 0, "Keep is visible", card.keep ? `${card.keep.w.toFixed(0)}x${card.keep.h.toFixed(0)}` : "missing");
        check(Boolean(card.unwind) && card.unwind.h >= 15 && card.unwind.w > 0, "Unwind is visible", card.unwind ? `${card.unwind.w.toFixed(0)}x${card.unwind.h.toFixed(0)}` : "missing");
        check(card.unwind.text === "Unwind", "and its label no longer repeats the branch", JSON.stringify(card.unwind.text));
        check(!card.oldProse, "the old unwind prose element is gone from the card");
        check(Boolean(card.details) && card.details.open === false, "Details is drawn and starts closed", card.details ? `open ${card.details.open}` : "no Details element");
        check(Boolean(card.sum) && /^details$/i.test(card.sum.text), "under one muted line", card.sum ? JSON.stringify(card.sum.text) : "missing");
        check(Boolean(card.details) && card.details.h <= (card.sum ? card.sum.h : 0) + 2, "and closed it takes a single line", card.details ? `details ${card.details.h.toFixed(1)}px  summary ${(card.sum ? card.sum.h : 0).toFixed(1)}px` : "no Details element");
        const cardEl = await page.$(`[data-rw-review="${ID}"]`);
        await cardEl.screenshot({ path: path.join(SHOTS, "card-1440-closed.png") });
        note(`screenshot ${path.join(SHOTS, "card-1440-closed.png")}`);

        // ---- 2. the disclosure owns its click ---------------------------------------------------------------
        section("the Details disclosure");
        if (card.details) {
          await page.click(`[data-rw-review="${ID}"] .rw-review-sum`);
          const opened = await waitFor(async () => (await readCard(page, ID)).details?.open === true, { what: "Details to open on a press", timeoutMs: 5_000 });
          const open = await readCard(page, ID);
          check(opened, "a press on Details opens it");
          check(!open.jumpNote && !/no agent card on this board/i.test(open.banner || ""), "and the press does not jump to an agent", `jumpNote ${open.jumpNote} banner ${JSON.stringify(open.banner)}`);
          check(/git push origin wtgui\//.test(open.body.text), "the full command is inside", open.body.text.slice(0, 90));
          check(open.body.text.includes(WORKTREE), "so is the worktree it ran from", WORKTREE);
          check(/the setting allows remote writes/.test(open.body.text), "so is the allow-policy", open.body.text.slice(0, 90));
          check(new RegExp(`git push origin --delete ${BRANCH.replace(/[/]/g, "\\/")}`).test(open.body.text), "and the exact command Unwind would run", open.body.text.slice(-120));
          check(open.body.keys.join(",") === "worktree,allowed,unwind", "each on its own labelled row", open.body.keys.join(","));
          await cardEl.screenshot({ path: path.join(SHOTS, "card-1440-open.png") });
          note(`screenshot ${path.join(SHOTS, "card-1440-open.png")}`);
          await page.click(`[data-rw-review="${ID}"] .rw-review-sum`);
          const closed = await waitFor(async () => (await readCard(page, ID)).details?.open === false, { what: "Details to close again", timeoutMs: 5_000 });
          check(closed, "a second press closes it");
        } else {
          check(false, "the card carries a Details disclosure", "no .rw-review-details in the markup");
        }

        // ---- 3. the keyboard path ----------------------------------------------------------------------------
        section("the keyboard");
        if (card.sum) {
          await page.focus(`[data-rw-review="${ID}"] [data-rw-review-unwind]`);
          await page.keyboard.press("Tab");
          const landed = await readCard(page, ID);
          check(landed.focus.cls.split(/\s+/).includes("rw-review-sum"), "Tab from Unwind lands on the Details line", `${landed.focus.tag}.${landed.focus.cls}`);
          check(landed.sum.outline !== "none" && parseFloat(landed.sum.outlineWidth) >= 1, "with a focus ring painted", `outline ${landed.sum.outline} ${landed.sum.outlineWidth}`);
          await page.keyboard.press("Enter");
          const byEnter = await waitFor(async () => (await readCard(page, ID)).details?.open === true, { what: "Enter to open Details", timeoutMs: 5_000 });
          check(byEnter, "Enter opens it");
          await page.keyboard.press("Space");
          const bySpace = await waitFor(async () => (await readCard(page, ID)).details?.open === false, { what: "Space to close Details", timeoutMs: 5_000 });
          check(bySpace, "and Space closes it again");
        } else {
          check(false, "the Details line is reachable from the keyboard", "the build draws no .rw-review-sum");
        }

        // ---- 4. Keep still keeps ------------------------------------------------------------------------------
        section("the handler");
        posted.length = 0;
        await page.click(`[data-rw-review="${ID}"] [data-rw-review-keep]`);
        const kept = await waitFor(
          async () => posted.some((p) => /\/api\/remote-write\/review$/.test(p.url) && /"action":"keep"/.test(p.body)),
          { what: "Keep's decision POST", timeoutMs: 6_000 },
        );
        check(kept, "Keep still posts the keep decision for its own id", JSON.stringify(posted));

        check(pageErrors.length === 0, "no uncaught page errors", pageErrors.join(" | "));
      },
      { viewport: { width: WIDTH, height: 1000 }, deviceScaleFactor: 1 },
    );
  } catch (e) {
    failures += 1;
    console.log(`FAIL  the run itself threw  ${(e && e.stack) || e}`);
  } finally {
    await panel.stop();
    console.log(`\n${failures === 0 ? "OK" : "FAILED"}  ${checks - failures}/${checks} checks passed`);
    console.log(`screenshots: ${SHOTS}`);
    process.exit(failures === 0 ? 0 : 1);
  }
}

await main();
