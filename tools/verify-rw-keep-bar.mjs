// The auto-allowed write review card: Keep is a full-width bar ABOVE Unwind, not a small chip beside it.
//
//   node tools/verify-rw-keep-bar.mjs [--shots <dir>]
//
// WHAT WAS WRONG (0.70.2). `remoteWriteReviewHtml()` drew the Keep button and the Unwind `.btn-deny` button into the
// shared `.ap-actions` row (`display:flex; flex-wrap:wrap`, no widths). Keep had no class at all, so it rendered at
// its label's width, while Unwind only filled the row because its label ("Unwind — delete remote branch origin/…")
// is wider than the 400px dock. The safe answer was the small control and the destructive one was the bar, and the
// two swapped places as soon as the label changed. Keep also wore the neutral grey of any button in the app, in a
// card whose whole language is green.
//
// NOW. Both states of the keep control carry `rw-keep` (Keep, and the unwound record's Dismiss), and the layout is
// scoped to this card:
//   .rw-review .ap-actions { flex-direction: column; align-items: stretch; }
//   .rw-review .ap-actions button { width: 100%; text-align: center; }
//   .rw-review button.rw-keep { …green family… } / :hover { … }
// so Keep is the full-width safe bar, Unwind is the red bar under it, and `.ap-actions` everywhere else (approvals,
// every other card) is untouched.
//
// WHAT IS DRIVEN, on a sandbox panel of this checkout (real server.js, its own port/store, assistant off) in real
// Chromium, with the page's own EventSource kept live so the review card arrives through the shipped event:
//   * at a 1280 viewport, at a 340 viewport, and on a card forced to exactly 340 px wide: Keep's `offsetWidth` equals
//     the card's inner width within a pixel, its box sits inside the card's content box, and it is ABOVE Unwind with
//     a gap and no overlap;
//   * Keep's rest and hover colours are green-dominant (the card's safe family), Unwind stays red;
//   * the keep control carries `rw-keep` in BOTH states (Keep, and the dismissed record's Dismiss);
//   * a plain `.ap-actions` outside `.rw-review` is still a row with an auto-width button;
//   * Keep still closes the card, and Unwind on a message-type write still drafts its message with no POST;
//   * a screenshot of the card per case under `--shots`.
//
// BEFORE IT LANDED. Run it on origin/main (or an export of it): Keep is ~55 px beside a ~211 px-wide Unwind, so the
// width, "above Unwind" and `rw-keep` checks fail — that is the defect, and those are the before numbers.
//
// The browser half needs a Playwright install. Point the script at one with PANEL_PLAYWRIGHT_ROOT (a directory
// holding node_modules/playwright, or the package itself); without one it says BROWSER-HALF-NOT-RUN and exits 2
// rather than passing on a half that never ran. The reader's live panel is never touched.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { ROOT, startPanel, waitFor } from "./panel-testkit.mjs";

let failures = 0;
let checks = 0;
function check(ok, label, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}
const section = (name) => console.log(`\n-- ${name}`);
const note = (text) => console.log(`      ${text}`);
const args = process.argv.slice(2);
const shotDirArg = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;
const shotsDir = shotDirArg ? path.resolve(shotDirArg) : path.join(ROOT, ".worktrees", ".rw-keep-shots");

// The page keeps its real stream so the review below arrives through the shipped `remote-write-review` event; the
// wrapper exists only so this file can push a frame the panel would have to run an agent to produce.
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

const REVIEW = (id, over = {}) => ({
  review: {
    id,
    kind: "push",
    state: "ran",
    confirmed: true,
    worktree: "C:/probe/keep-bar",
    project: "",
    branch: "wtgui/probe-keep-bar-3a9352",
    remote: "origin",
    refs: "refs/heads/wtgui/probe-keep-bar-3a9352",
    sha: "0123456789abcdef",
    command: "git push origin wtgui/probe-keep-bar-3a9352",
    why: "the setting allows remote writes",
    at: Date.now(),
    unwind: {
      type: "delete-branch",
      label: "delete remote branch origin/wtgui/probe-keep-bar-3a9352",
      command: "git push origin --delete wtgui/probe-keep-bar-3a9352",
    },
    ...over,
  },
});

// One read of everything the assertions need, in the page's own pixels.
const readCard = (page, id) =>
  page.evaluate((reviewId) => {
    const card = [...document.querySelectorAll("#approval-list [data-rw-review]")].find((c) => c.dataset.rwReview === reviewId);
    if (!card) return null;
    const keep = card.querySelector("[data-rw-review-keep]");
    const unwind = card.querySelector("[data-rw-review-unwind]");
    const actions = card.querySelector(".ap-actions");
    const cs = getComputedStyle(card);
    const cr = card.getBoundingClientRect();
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, center: r.left + r.width / 2 };
    };
    const look = (el) => {
      if (!el) return null;
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor, borderColor: s.borderTopColor, textAlign: s.textAlign };
    };
    return {
      card: {
        ...rect(card),
        clientWidth: card.clientWidth,
        paddingLeft: parseFloat(cs.paddingLeft),
        paddingRight: parseFloat(cs.paddingRight),
        innerWidth: card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
      },
      actions: actions ? { direction: getComputedStyle(actions).flexDirection, align: getComputedStyle(actions).alignItems } : null,
      keep: keep
        ? { ...rect(keep), offsetWidth: keep.offsetWidth, classes: keep.className, text: keep.textContent.trim(), ...look(keep) }
        : null,
      unwind: unwind ? { ...rect(unwind), offsetWidth: unwind.offsetWidth, classes: unwind.className, text: unwind.textContent.trim(), ...look(unwind) } : null,
    };
  }, id);

// A colour reads as its family when its own channel leads by a clear margin (no exact hex pinned: the sheet may
// retune the family, and a reader still needs it to be GREEN or RED).
const channels = (rgb) => (/(\d+)\D+(\d+)\D+(\d+)/.exec(rgb || "") || []).slice(1, 4).map(Number);
const greenDominant = (rgb) => {
  const [r, g, b] = channels(rgb);
  return g > r + 12 && g > b + 8;
};
const redDominant = (rgb) => {
  const [r, g, b] = channels(rgb);
  return r > g + 24 && r > b + 24;
};

const emitReview = (page, id, over = {}) => page.evaluate((payload) => window.__emit("remote-write-review", payload), REVIEW(id, over));

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the review card's Keep bar", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
    process.exit(2);
  }
  mkdirSync(shotsDir, { recursive: true });
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-rw-keep-"));
  const panel = await startPanel({ dir, config: { assistant: { enabled: false }, fetchSeconds: -1 } });
  try {
    console.log(`sandbox: ${panel.base}`);
    await withBrowser(
      async ({ page, pageErrors }) => {
        const posted = [];
        page.on("request", (req) => {
          if (req.method() !== "POST") return;
          if (/\/api\/remote-write\/(review|unwind)$/.test(req.url())) posted.push({ url: req.url(), body: req.postData() || "" });
        });
        await page.addInitScript(CAPTURE_STREAMS);
        await page.setViewportSize({ width: 1280, height: 1000 });
        await openPage(page, panel.base, { selector: "#health.ok" });
        await page.waitForSelector("#approvals", { state: "attached", timeout: 30_000 });
        await page.waitForFunction(() => Array.isArray(window.__es) && window.__es.length > 0, { timeout: 20_000 });

        // ---- 1. the card arrives through the shipped event, in the state the reader sees ----------------------
        section("the review card");
        await emitReview(page, "rwv_keep_bar");
        const up = await waitFor(async () => Boolean(await readCard(page, "rwv_keep_bar")), { what: "the review card", timeoutMs: 10_000 });
        let card = await readCard(page, "rwv_keep_bar");
        check(up && Boolean(card), "an auto-allowed write is drawn as a review card", card ? `keep ${JSON.stringify(card.keep.text)}` : "no card");
        check(card?.keep?.classes.split(/\s+/).includes("rw-keep"), "Keep carries rw-keep", `class ${JSON.stringify(card?.keep?.classes)}`);
        check(card?.actions?.direction === "column", "the card's action row is a column", `flex-direction ${card?.actions?.direction}`);
        check(card?.actions?.align === "stretch", "and it stretches its children", `align-items ${card?.actions?.align}`);

        // ---- 2. the three widths: Keep is the card's inner width, above Unwind -------------------------------
        const cases = [
          { name: "1280 viewport", width: 1280, cardWidth: null },
          { name: "340 viewport", width: 340, cardWidth: null },
          { name: "card 340 wide", width: 1280, cardWidth: 340 },
        ];
        const id = "rwv_keep_bar";
        for (let i = 0; i < cases.length; i += 1) {
          const c = cases[i];
          section(c.name);
          await page.setViewportSize({ width: c.width, height: c.width < 500 ? 760 : 1000 });
          // The same id each time: the page's own map replaces the record, so exactly one card is on the dock.
          await emitReview(page, id);
          await waitFor(async () => Boolean(await readCard(page, id)), { what: `the ${c.name} card`, timeoutMs: 10_000 });
          if (c.cardWidth) await page.evaluate(({ id: rid, w }) => {
            document.querySelector(`[data-rw-review="${rid}"]`).style.width = `${w}px`;
          }, { id, w: c.cardWidth });
          card = await readCard(page, id);
          const keep = card.keep;
          const unwind = card.unwind || {};
          const inner = card.card.innerWidth;
          const widthGap = Math.abs(keep.offsetWidth - inner);
          const gapBelow = (unwind.top ?? keep.bottom) - keep.bottom;
          check(widthGap <= 1, "Keep's offsetWidth equals the card's inner width", `keep ${keep.offsetWidth}px  inner ${inner.toFixed(1)}px  card ${card.card.width.toFixed(1)}px  Δ ${widthGap}`);
          check(keep.left >= card.card.left + card.card.paddingLeft - 0.5 && keep.right <= card.card.right - card.card.paddingRight + 0.5, "Keep sits inside the card's content box", `left ${keep.left.toFixed(1)}  right ${keep.right.toFixed(1)}  content ${(card.card.left + card.card.paddingLeft).toFixed(1)}..${(card.card.right - card.card.paddingRight).toFixed(1)}`);
          check(Boolean(card.unwind), "Unwind is drawn beside the state it undoes", unwind.text || "");
          check(keep.bottom <= unwind.top + 0.5, "Keep is ABOVE Unwind with no overlap", `keep.bottom ${keep.bottom.toFixed(1)}  unwind.top ${(unwind.top ?? NaN).toFixed(1)}`);
          check(gapBelow >= 4, "and a gap separates the two bars", `${gapBelow.toFixed(1)}px`);
          check(Math.abs(unwind.offsetWidth - inner) <= 1, "Unwind is the full-width red bar underneath", `unwind ${unwind.offsetWidth}px  inner ${inner.toFixed(1)}px`);
          check(keep.textAlign === "center", "Keep's label is centred", `text-align ${keep.textAlign}`);
          check(Math.abs(keep.center - (card.card.left + card.card.paddingLeft + inner / 2)) <= 1, "and the bar is centred in the card", `keep centre ${keep.center.toFixed(1)}  card centre ${(card.card.left + card.card.paddingLeft + inner / 2).toFixed(1)}`);
          const el = await page.$(`[data-rw-review="${id}"]`);
          const file = path.join(shotsDir, `0${i + 1}-${c.width}-${c.cardWidth ? "card340" : "viewport"}.png`);
          await el.screenshot({ path: file });
          note(`screenshot ${file}`);
        }

        // ---- 3. the colour language: Keep is green (hover included), Unwind is red -----------------------------
        section("the colour language");
        const colourId = "rwv_keep_bar";
        await page.setViewportSize({ width: 1280, height: 1000 });
        await emitReview(page, colourId);
        await waitFor(async () => Boolean(await readCard(page, colourId)), { what: "the colour card", timeoutMs: 10_000 });
        const rest = await readCard(page, colourId);
        check(greenDominant(rest.keep.color) && greenDominant(rest.keep.borderColor), "Keep's text and border are green", `color ${rest.keep.color}  border ${rest.keep.borderColor}`);
        check(greenDominant(rest.keep.background), "and its resting fill is green", `background ${rest.keep.background}`);
        check(redDominant(rest.unwind.color) && redDominant(rest.unwind.borderColor), "Unwind stays red", `color ${rest.unwind.color}  border ${rest.unwind.borderColor}`);
        await page.hover(`[data-rw-review="${colourId}"] [data-rw-review-keep]`);
        await new Promise((r) => setTimeout(r, 200));
        const hovered = await readCard(page, colourId);
        check(hovered.keep.background !== rest.keep.background, "Keep has a hover state of its own", `rest ${rest.keep.background}  hover ${hovered.keep.background}`);
        check(greenDominant(hovered.keep.background) && greenDominant(hovered.keep.color), "and the hover is in the same green family", `hover ${hovered.keep.background} on ${hovered.keep.color}`);
        await page.mouse.move(2, 2);

        // ---- 4. the unwound record's one control is the same slot ---------------------------------------------
        section("the dismissed state");
        const unwoundId = "rwv_keep_bar";
        await emitReview(page, unwoundId, { state: "unwound" });
        await waitFor(async () => Boolean(await readCard(page, unwoundId)), { what: "the unwound card", timeoutMs: 10_000 });
        const unwound = await readCard(page, unwoundId);
        check(unwound.keep.classes.split(/\s+/).includes("rw-keep"), "Dismiss carries rw-keep too", `class ${JSON.stringify(unwound.keep.classes)}`);
        check(unwound.keep.text === "Dismiss", "and it is still the Dismiss control", `text ${JSON.stringify(unwound.keep.text)}`);
        check(Math.abs(unwound.keep.offsetWidth - unwound.card.innerWidth) <= 1, "it fills the row on its own", `keep ${unwound.keep.offsetWidth}px  inner ${unwound.card.innerWidth.toFixed(1)}px`);

        // ---- 5. .ap-actions outside .rw-review is untouched ----------------------------------------------------
        section("the scope");
        const plain = await page.evaluate(() => {
          const box = document.createElement("div");
          box.className = "ap-actions";
          box.id = "probe-plain-ap-actions";
          box.innerHTML = '<button type="button">plain</button>';
          document.body.appendChild(box);
          const cs = getComputedStyle(box);
          const br = box.getBoundingClientRect();
          const child = box.querySelector("button").getBoundingClientRect();
          const out = { direction: cs.flexDirection, align: cs.alignItems, box: br.width, button: child.width };
          box.remove();
          return out;
        });
        check(plain.direction === "row", "a plain .ap-actions is still a row", `flex-direction ${plain.direction}`);
        check(plain.button < plain.box * 0.6, "with an auto-width button, not a full-width bar", `button ${plain.button.toFixed(1)}px of ${plain.box.toFixed(1)}px`);

        // ---- 6. the handlers the class must not disturb -------------------------------------------------------
        // The delegated handler keys on the data attributes, which the markup keeps (`rw-keep` is a class beside
        // them, not a replacement). The review is pushed through the page's own event, so the SERVER does not hold
        // this id: Keep's POST is the proof the handler ran, and the dismissal itself belongs to the dock's gate.
        section("the handlers");
        const keepId = "rwv_keep_bar";
        await emitReview(page, keepId);
        await waitFor(async () => Boolean(await readCard(page, keepId)), { what: "the keep-click card", timeoutMs: 8_000 });
        await page.click(`[data-rw-review="${keepId}"] [data-rw-review-keep]`);
        const keepPosted = await waitFor(
          async () => posted.some((p) => /\/api\/remote-write\/review$/.test(p.url) && /"action":"keep"/.test(p.body)),
          { what: "Keep's decision POST", timeoutMs: 6_000 },
        );
        check(keepPosted, "Keep still posts the keep decision for its own id", JSON.stringify(posted));

        // An agent card so the page has a reply box for the draft to land in.
        const thread = "probe-keep-bar-thread";
        await page.evaluate(
          ({ t, w }) => {
            window.__emit("jobs", {
              jobs: [
                {
                  id: "probe-keep-bar-job",
                  thread: t,
                  turn: 1,
                  status: "stopped",
                  prompt: "a probe agent for the review card's Unwind",
                  displayPrompt: "a probe agent for the review card's Unwind",
                  cwd: w,
                  worktree: false,
                  worktreePath: null,
                  projectPath: null,
                  ownerPath: w,
                  branch: "wtgui/probe-keep-bar",
                  runId: null,
                  startedAt: new Date().toISOString(),
                  endedAt: new Date().toISOString(),
                  model: "probe",
                  lines: [],
                  artifacts: [],
                  attachments: [],
                  subagents: [],
                },
              ],
            });
          },
          { t: thread, w: path.join(dir, "repos", "probe-tree").replace(/\\/g, "/") },
        );
        await page.waitForSelector(`.job[data-thread="${thread}"]`, { state: "attached", timeout: 10_000 });
        posted.length = 0;
        await emitReview(page, keepId, {
          branch: "main",
          refs: "refs/heads/main",
          agentThread: thread,
          unwind: { type: "message", label: `message ${thread}`, text: "You were allowed to push main without being asked. Please check whether that push was intended." },
        });
        await waitFor(async () => Boolean(await readCard(page, keepId)), { what: "the draft card", timeoutMs: 8_000 });
        await page.click(`[data-rw-review="${keepId}"] [data-rw-review-unwind]`);
        const drafted = await waitFor(
          async () =>
            page.evaluate((t) => {
              const box = document.querySelector(`.reply-box[data-reply="${t}"]`);
              return box ? box.textContent.includes("allowed to push main") : false;
            }, thread),
          { what: "Unwind to draft its message", timeoutMs: 6_000 },
        );
        check(drafted, "Unwind still drafts its message in the reply box");
        check(posted.length === 0, "and runs nothing", JSON.stringify(posted));

        check(pageErrors.length === 0, "no uncaught page errors", pageErrors.join(" | "));
      },
      { viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 },
    );
  } catch (e) {
    failures += 1;
    console.log(`FAIL  the run itself threw  ${(e && e.stack) || e}`);
  } finally {
    await panel.stop();
    console.log(`\n${failures === 0 ? "OK" : "FAILED"}  ${checks - failures}/${checks} checks passed`);
    console.log(`screenshots: ${shotsDir}`);
    process.exit(failures === 0 ? 0 : 1);
  }
}

await main();
