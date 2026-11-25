// test/e2e/initiative-ask-row.spec.mjs - the initiative card's assistant row, pressed for real in headless Chromium.
//
// WHAT THIS IS. On an initiative card the Assistants fold lists one row per assistant ("Assistant #2 - tasks 17"). A
// press on that name already opened the assistant's chat; it now ALSO writes the reader's question about THIS
// initiative into that assistant's composer - `Question about <the card's title>: ` - with the caret after the colon
// and the space, so the first keystroke continues the sentence. Nothing is sent.
//
// The contract it has to keep is the wave lane's owner chip's (public/assistant.js `startAssistantLine`): the line goes
// through `writeBox`, is kept as the COMPOSER'S OWN DRAFT (the `input` event public/app.js answers into
// state.replyDrafts) so a repaint draws it back, the caret is placed at the end, and Enter stays the reader's to press.
// A DOM-only write is what row 301 already proved wrong from the send's side.
//
//   RUN   node --test --test-reporter=spec test/e2e/initiative-ask-row.spec.mjs
//         npm run test:e2e:initiative-ask-row
//
//         INITIATIVE_ASK_SHOTS=<dir>   where the screenshots go (default: <tmp>/wtgui-initiative-ask-shots)
//
// THE PANEL IS ITS OWN, AND IT IS NOT 7331. A throwaway server.js from THIS checkout (tools/panel-testkit.mjs), a spare
// port, its own PANELS state directory, real git worktrees, its own assistant store, its own queues and its own
// initiatives file. The reader's live panel is never started, restarted, read or written.
//
// THE FIXTURE is two initiatives and two assistants, arranged so every claim has a wrong answer nearby:
//
//   Alpha: the POC build's data access   trees A1 (Assistant #2 has a row) and A2 (#1 does)  -> both assistants
//   Beta - the delivery push             tree B1 (#1 has a row)                            -> Assistant #1 only
//
//   so #2 appears on ONE initiative and #1 on BOTH, which is what makes "the second press replaces the line instead of
//   stacking two" a claim about the SAME box (pressing #1 on Alpha and then on Beta).
//
// THE CLAIMS, and where each is measured:
//
//   the right assistant's chat opens        after the press, #as-chat-2 is on screen and #as-chat is not (and the
//                                           reverse for #1): the box asked is the PRESSED assistant's own host.
//   the box holds exactly the line          innerText of that thread's reply box equals `Question about <title>: `,
//                                           with the card's own title string (its apostrophe and its inner colon in
//                                           the fixture) and never an id.
//   the caret is after the colon and space  the box has focus and typing appends: "why" makes the text the line plus
//                                           "why", and a second keystroke lands after that.
//   it lives in the composer's draft        state.replyDrafts[thread] holds the same line - the store a repaint reads -
//                                           and a FORCED rebuild of the card (a new line in the page's job view, which
//                                           changes the conversation's signature) draws the text back with the caret.
//   a state poll keeps it                   a real GET /api/state poll (refreshSeconds 2 in this sandbox) leaves the
//                                           text, the focus and the caret where they were, and typing continues the line.
//   nothing is sent                         no POST to /api/assistant/say for the whole run, the turn count in the
//                                           pane does not move, and the line is still in the box seconds later.
//   a second press replaces                  pressing #1 on Beta leaves exactly one "Question about" line in the box:
//                                           Beta's, not Alpha's under it.
//
// A FAILING CASE IS A FAILURE, NOT A TEST TO RE-AIM. If a case disagrees with the panel, the panel is what the report
// is about; the assertion is not made to fit.
//
// Exit is node:test's: 0 when every case passed, 1 when one failed, and the summary line counts them.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { attachPageCollectors, loadPlaywright } from "../../tools/browser.mjs";
import { configureRepo, freePort, git, slash, startPanel } from "../../tools/panel-testkit.mjs";

// The reader's own panel. This run must never bind it, and never write its store.
const LIVE_PORT = 7331;

const PW = loadPlaywright();
const SKIP = PW ? null : "BROWSER-HALF-NOT-RUN: no Playwright install found (set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright)";
const it = (name, fn) => (PW ? test(name, fn) : test(name, { skip: SKIP }, () => {}));

// ---- the fixture's words ------------------------------------------------------------------------------------------
// A title with an apostrophe and an inner colon on purpose: the line is built from the string the CARD draws, so the
// press has to survive the HTML escaping the card's title goes through and keep the reader's punctuation as written.
const TITLE_A = "Alpha: the POC build's data access";
const TITLE_B = "Beta - the delivery push";
const ID_A = "init-alpha";
const ID_B = "init-beta";
const LINE_A = `Question about ${TITLE_A}: `;
const LINE_B = `Question about ${TITLE_B}: `;
const PROJECT = "fixture";
const THREAD_1 = "panel-assistant";
const THREAD_2 = "panel-assistant-2";

const at = (msAgo) => new Date(Date.now() - msAgo).toISOString();

// ---- the run's own state ------------------------------------------------------------------------------------------
let store = null;
let fixture = null;
let panel = null;
let browser = null;
let context = null;
let page = null;
let pageErrors = [];
let consoleErrors = [];
let shots = null;
let sawSay = [];
const ledger = { cases: {}, at: null };

function makeFixture(base) {
  const repo = path.join(base, "repos", PROJECT);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  configureRepo(repo);
  writeFileSync(path.join(repo, "README.md"), "# initiative fixture\n", "utf8");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "root");
  const treeOf = (name) => slash(path.join(repo, ".worktrees", name));
  const cut = (name) => {
    git(repo, "worktree", "add", "-q", "-b", `wtgui/${name}`, treeOf(name), "main");
    return treeOf(name);
  };
  return { base, repo: slash(repo), a1: cut("alpha-one"), a2: cut("alpha-two"), b1: cut("beta-one") };
}

// One settled turn per assistant thread: an assistant with a conversation types into its THREAD's reply box, and that
// box is the composer whose draft store the prefill has to reach. Nothing here can start a run (the sandbox points at
// a dead gateway and the assistant is switched off), so a send would fail loudly rather than quietly.
function turn(thread, id, minutesAgo) {
  const startedAt = Date.now() - minutesAgo * 60_000;
  return {
    id,
    thread,
    turn: 1,
    prompt: "a fixture turn, so this thread has a reply box",
    status: "done",
    exitCode: 0,
    startedAt: at(minutesAgo),
    endedAt: at(minutesAgo - 0.5),
    durationMs: 30_000,
    finalMessage: "done",
    cwd: fixture.repo,
    ownerPath: fixture.repo,
    worktreePath: fixture.repo,
    worktree: PROJECT,
    tokens: { total: 1200 },
    stats: { context_used: 1000, context_max: 200_000, total_tokens: 1200, cost_usd: 0.01, input_tokens: 900, output_tokens: 300 },
    lines: [{ kind: "say", text: "this thread has a reply box", at: startedAt + 1000 }],
  };
}

const queueRow = (id, worktree, state, title) => ({ id, title, state, thread: null, threads: [], files: [], worktree, project: PROJECT });

const readText = (sel) =>
  page.evaluate((selector) => {
    const box = document.querySelector(selector);
    return box ? String(box.innerText ?? "").replace(/\u00a0/g, " ") : null;
  }, sel);

const boxSel = (n, thread) => `#as-chat${n === 1 ? "" : `-${n}`} .reply-box[data-reply="${thread}"]`;

// What one press left on screen, read from the pane the reader sees plus the store the page keeps the draft in.
// WHICH PANE IS ON SCREEN is the `.as-pane` (one per assistant); the `.as-subpane` inside it is decided by the SUB-tab
// alone, so every assistant's Chat section keeps its nodes and only the pressed assistant's PANE is un-hidden.
const readAsk = (assistantNo, thread) =>
  page.evaluate(
    ([n, th]) => {
      const suffix = n === 1 ? "" : `-${n}`;
      const chat = document.getElementById(`as-chat${suffix}`);
      const box = chat?.querySelector(`.reply-box[data-reply="${th}"]`) || document.getElementById(`as-first-text${suffix}`);
      const paneShown = (id) => {
        const pane = document.getElementById(`as-${id}`);
        return Boolean(pane) && !pane.classList.contains("hidden");
      };
      return {
        chatShown: paneShown(n === 1 ? "assistant-1" : `assistant-${n}`) && Boolean(chat),
        otherPaneHidden: !paneShown(n === 1 ? "assistant-2" : "assistant-1"),
        tabOn: document.querySelector(`#as-tabs [data-as-tab="assistant-${n}"]`)?.classList.contains("is-on") || false,
        boxFound: Boolean(box),
        boxKey: box ? String(box.dataset.chipbox || "") : null,
        text: box ? String(box.innerText ?? "").replace(/\u00a0/g, " ") : null,
        value: box && box.value !== undefined ? String(box.value) : null,
        focused: Boolean(box) && document.activeElement === box,
        draft: String(state.replyDrafts?.[th] ?? ""),
        jobs: chat ? chat.querySelectorAll(".job").length : 0,
      };
    },
    [assistantNo, thread],
  );

// A STATE POLL, through the panel's own reader: `resync({automatic:true})` is the call app.js's anti-entropy clock makes
// (public/app.js, the 30s tick), so what this proves is the page applying a real GET /api/state, not a painter invoked
// by hand. `state.snapshotGeneration` is the count applySnapshot keeps, and it must move for the case to count.
async function nextSnapshot() {
  const before = await page.evaluate(() => state.snapshotGeneration || 0);
  await page.evaluate(() => resync({ automatic: true }));
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => state.snapshotGeneration || 0);
  assert.ok(after > before, `the panel applied a real /api/state read (generation ${before} -> ${after})`);
  return after;
}

async function shot(name) {
  const file = path.join(shots, `${name}.png`);
  await page.screenshot({ path: file });
  return { file, bytes: statSync(file).size };
}

// Open the Initiatives tab, unfold the card and (idempotently) its Assistants fold, and hand back the row to press.
async function openCard(id) {
  await page.click('#as-tabs [data-as-tab="initiatives"]');
  await page.waitForSelector("#as-initiatives:not(.hidden)", { timeout: 30_000 });
  const card = `#as-initiatives [data-init-card="${id}"]`;
  if ((await page.locator(card).count()) === 0) {
    // A fresh pane draws the cards on its first read; the read is a whole-store join, so give it the time it takes.
    await page.waitForSelector(card, { timeout: 45_000 });
  }
  if ((await page.locator(`${card}.is-titlecard`).count()) > 0) {
    await page.click(`${card} .init-head-btn`);
    await page.waitForSelector(`#as-initiatives [data-init-card="${id}"]:not(.is-titlecard)`, { timeout: 15_000 });
  }
  if ((await page.locator(`${card} [data-init-assist-fold]`).count()) > 0) {
    const open = await page.evaluate((sel) => document.querySelector(sel)?.getAttribute("aria-expanded") === "true", `${card} [data-init-assist-fold]`);
    if (!open) {
      await page.click(`${card} [data-init-assist-fold]`);
      await page.waitForSelector(`${card} .init-assists`, { timeout: 15_000 });
    }
  }
  await page.waitForSelector(`${card} [data-init-assistant]`, { timeout: 20_000 });
}

async function pressRow(id, assistantId) {
  const sel = `#as-initiatives [data-init-card="${id}"] [data-init-assistant="${assistantId}"]`;
  await page.waitForSelector(sel, { timeout: 20_000 });
  await page.locator(sel).click();
}

// ---- boot ---------------------------------------------------------------------------------------------------------
before(async () => {
  if (!PW) return;
  store = mkdtempSync(path.join(os.tmpdir(), "wtgui-initiative-ask-"));
  for (const dir of ["logs", path.join("logs", "assistants", "assistant-1"), path.join("logs", "assistants", "assistant-2")]) {
    mkdirSync(path.join(store, dir), { recursive: true });
  }
  fixture = makeFixture(store);

  // The two stores that name the assistants and their threads. #1 keeps the panel's long-standing thread id.
  writeFileSync(
    path.join(store, "logs", "assistant.json"),
    JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }, null, 1),
    "utf8",
  );
  writeFileSync(
    path.join(store, "logs", "assistants.json"),
    JSON.stringify(
      {
        version: 1,
        assistants: [
          { id: "assistant-1", name: "Assistant #1", threadId: THREAD_1, rules: [] },
          { id: "assistant-2", name: "Assistant #2", threadId: THREAD_2, rules: [] },
        ],
      },
      null,
      1,
    ),
    "utf8",
  );

  // The rows that put each assistant on an initiative: the tab reads them through the queue, keyed by the row's own
  // worktree path, so a row on A2 is "Assistant #1 on Alpha" and nothing else.
  writeFileSync(
    path.join(store, "logs", "assistants", "assistant-1", "queue.json"),
    JSON.stringify(
      {
        version: 3,
        nextId: 4,
        tasks: [
          queueRow(1, fixture.a2, "queued", "map the DBA's table"),
          queueRow(2, fixture.a2, "done", "read the real Oracle shape"),
          queueRow(3, fixture.b1, "queued", "ship the delivery push"),
        ],
      },
      null,
      1,
    ),
    "utf8",
  );
  writeFileSync(
    path.join(store, "logs", "assistants", "assistant-2", "queue.json"),
    JSON.stringify(
      {
        version: 3,
        nextId: 2,
        tasks: [queueRow(1, fixture.a1, "running", "one confirmed column per table")],
      },
      null,
      1,
    ),
    "utf8",
  );

  const jobs = [turn(THREAD_1, "fixture-turn-1", 30), turn(THREAD_2, "fixture-turn-2", 20)];
  writeFileSync(path.join(store, "logs", "jobs.json"), JSON.stringify({ savedAt: at(0), jobs }, null, 1), "utf8");

  // The map itself: two initiatives, four tree attachments, each attachment naming who put it there.
  const attachedAt = at(120);
  const initiative = (id, title, description) => ({
    id,
    title,
    description,
    createdAt: attachedAt,
    updatedAt: attachedAt,
    createdBy: "reader",
    updatedBy: "reader",
    order: null,
    orderAt: null,
    orderBy: null,
    archivedAt: null,
    archivedBy: null,
    history: [{ at: attachedAt, by: "reader", action: "create", tree: null, detail: title }],
  });
  const treeRecord = (p, ids) => ({
    path: p,
    initiatives: ids,
    at: attachedAt,
    by: "reader",
    members: Object.fromEntries(ids.map((id) => [id, { at: attachedAt, by: "reader" }])),
  });
  writeFileSync(
    path.join(store, "logs", "initiatives.json"),
    JSON.stringify(
      {
        version: 1,
        savedAt: attachedAt,
        initiatives: [
          initiative(ID_A, TITLE_A, "the POC build's own tables, read in Oracle as well as here"),
          initiative(ID_B, TITLE_B, "the turnover that carries the POC's work to UAT"),
        ],
        trees: {
          [fixture.a1.toLowerCase()]: treeRecord(fixture.a1, [ID_A]),
          [fixture.a2.toLowerCase()]: treeRecord(fixture.a2, [ID_A, ID_B]),
          [fixture.b1.toLowerCase()]: treeRecord(fixture.b1, [ID_B]),
        },
      },
      null,
      1,
    ),
    "utf8",
  );

  shots = path.resolve(process.env.INITIATIVE_ASK_SHOTS || path.join(os.tmpdir(), "wtgui-initiative-ask-shots"));
  mkdirSync(shots, { recursive: true });

  const port = await freePort();
  assert.notEqual(port, LIVE_PORT, "the OS handed out the reader's own port - refusing to boot over a live panel");
  panel = await startPanel({
    dir: store,
    port,
    config: {
      // A REAL POLL, every two seconds: "a state poll keeps the line" is a claim about the panel's own clock, not about
      // a call the test makes by hand.
      refreshSeconds: 2,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      slowSeconds: 3600,
      fetchSeconds: -1,
      discoverSeconds: 3600,
      assistant: { enabled: false },
      apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
      projects: [{ name: PROJECT, path: fixture.repo, mainBranch: "main" }],
      initiativesFile: path.join(store, "logs", "initiatives.json"),
      assistantsFile: path.join(store, "logs", "assistants.json"),
    },
  });
  console.log(`      initiative-ask spec: panel ${panel.base} (store ${store}), shots ${shots}`);

  browser = await PW.chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("wm.assistantOpen", "1");
      localStorage.removeItem("wtgui.zoom");
    } catch {
      /* a browser with storage off still opens the rail on its own default */
    }
  });
  page = await context.newPage();
  page.setDefaultTimeout(25_000);
  ({ pageErrors, consoleErrors } = attachPageCollectors(page));
  // Every write the page attempts is counted; a prefill must never become one. The route only RECORDS - the panel
  // answers the request itself.
  await page.route("**/api/assistant/say", async (route) => {
    sawSay.push({ at: new Date().toISOString(), body: route.request().postData() });
    await route.continue();
  });
  await page.goto(panel.base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#assistant:not([hidden])", { timeout: 45_000 });
  await page.waitForSelector('#as-tabs [data-as-tab="initiatives"]', { timeout: 45_000 });
  // THE ROSTER IS A READ OF ITS OWN (/api/assistant), and the Initiatives tab's cards come from another one. A press
  // names an assistant the page must already know, so the run starts from the state a reader is in: both assistants
  // are on the float and their panes exist.
  await page.waitForFunction(() => (state.assistant?.assistants || []).length >= 2, null, { timeout: 45_000 });
  await page.waitForSelector("#as-assistant-2", { state: "attached", timeout: 30_000 });
});

after(async () => {
  ledger.at = new Date().toISOString();
  if (shots) {
    try {
      writeFileSync(path.join(shots, "initiative-ask-ledger.json"), JSON.stringify(ledger, null, 1), "utf8");
    } catch {
      /* the summary printed below still carries the numbers */
    }
  }
  for (const [name, row] of Object.entries(ledger.cases)) {
    console.log(`      ${name}: ${JSON.stringify(row)}`);
  }
  if (browser) await browser.close().catch(() => {});
  if (panel) await panel.stop();
  if (shots) console.log(`      initiative-ask spec: screenshots + ledger in ${shots}`);
});

// ---- the run's own hygiene ----------------------------------------------------------------------------------------
it("the run's panel bound its own port, not the reader's 7331", async () => {
  assert.notEqual(panel.port, LIVE_PORT, "the spec never binds the live panel's port");
  assert.match(panel.base, /^http:\/\/127\.0\.0\.1:\d+$/, `the panel is a loopback listener of this run (${panel.base})`);
  assert.equal((await fetch(`${panel.base}/api/health`)).status, 200, "and it is the panel this run started");
});

it("the fixture reached the tab: two initiatives, each naming the assistants its trees carry", async () => {
  await openCard(ID_A);
  await openCard(ID_B);
  const drawn = await page.evaluate(
    ([a, b]) => {
      const rows = (id) =>
        [...document.querySelectorAll(`#as-initiatives [data-init-card="${id}"] [data-init-assistant]`)].map((el) => ({
          id: el.dataset.initAssistant,
          title: el.dataset.initTitle,
          tab: el.textContent.trim(),
        }));
      return { a: rows(a), b: rows(b) };
    },
    [ID_A, ID_B],
  );
  assert.deepEqual(drawn.a.map((r) => r.id).sort(), ["assistant-1", "assistant-2"], "Alpha lists both assistants");
  assert.deepEqual(drawn.b.map((r) => r.id), ["assistant-1"], "Beta lists only the assistant with a row on its tree");
  assert.equal(drawn.a.find((r) => r.id === "assistant-2").title, TITLE_A, "the row carries the title the card draws");
  assert.equal(drawn.b[0].title, TITLE_B, "and Beta's row carries Beta's");
  ledger.cases.fixture = drawn;
});

// ---- ask 1: a press from a COLLAPSED tasks fold ---------------------------------------------------------------
it("[collapsed tasks fold] the press opens THAT assistant's chat with the line, the caret after it and nothing sent", async () => {
  await openCard(ID_A);
  // The row's own tasks fold is collapsed: its list is not drawn, which is the state most presses start from.
  const foldOpen = await page.evaluate(
    (sel) => document.querySelector(sel)?.getAttribute("aria-expanded") === "true",
    `#as-initiatives [data-init-card="${ID_A}"] [data-init-task-fold="${ID_A}::assistant-2"]`,
  );
  assert.equal(foldOpen, false, "the row this case presses has its tasks fold collapsed");

  await pressRow(ID_A, "assistant-2");
  await page.waitForSelector("#as-assistant-2:not(.hidden)", { timeout: 25_000 });
  await page.waitForTimeout(350);
  const ask = await readAsk(2, THREAD_2);
  ledger.cases.collapsed = ask;

  assert.equal(ask.tabOn && ask.chatShown, true, "Assistant #2's tab and Chat are on screen");
  assert.equal(ask.otherPaneHidden, true, "Assistant #1's pane is not - the pressed assistant's own host was asked");
  assert.ok(ask.boxFound, "the pane drew a composer to write in");
  assert.equal(ask.boxKey, `reply:${THREAD_2}`, "the box is that thread's OWN reply box, not the intro box");
  assert.equal(ask.text, LINE_A, `the box holds exactly "Question about <the card's title>: " (got ${JSON.stringify(ask.text)})`);
  assert.equal(ask.draft, LINE_A, "the line is in the composer's own draft store (state.replyDrafts), not only the DOM");
  assert.equal(ask.focused, true, "the box has the focus, so the next keystroke lands in it");
  assert.equal(sawSay.length, 0, "the press posted nothing");
  await shot("1-collapsed-fold-ask");
});

// ---- ask 2: typing appends immediately -----------------------------------------------------------------------
it("typing appends after the colon and space, from the caret the press left", async () => {
  await page.keyboard.type("why");
  await page.waitForTimeout(150);
  const typed = await readAsk(2, THREAD_2);
  ledger.cases.typed = typed;
  assert.equal(typed.text, `${LINE_A}why`, `the keystrokes landed after the trailing space (got ${JSON.stringify(typed.text)})`);
  assert.equal(typed.draft, `${LINE_A}why`, "and the draft store follows the box, as it does for any typing");
  assert.equal(sawSay.length, 0, "typing sent nothing on its own");
});

// ---- ask 3: a forced rebuild of the card keeps the line, the focus and the caret ------------------------------
it("a forced repaint draws the line back from the draft store, and typing continues at its end", async () => {
  // The reader clicks away first: this is a DRAFT test, not a focused-box test. The rebuild itself is the one a live
  // thread causes - a new line in the conversation changes the card's signature, so the pane rebuilds the box.
  await page.evaluate(() => (document.activeElement && document.activeElement.blur ? document.activeElement.blur() : null));
  await page.evaluate((thread) => {
    const j = [...state.jobs.values()].find((x) => (x.thread || x.id) === thread);
    if (j) j.lines = [...(j.lines || []), { kind: "say", text: "a later line, so the card is rebuilt", at: Date.now() }];
    window.__assistantRenderChat(thread);
  }, THREAD_2);
  await page.waitForTimeout(400);
  const after = await readAsk(2, THREAD_2);
  ledger.cases.repainted = after;
  assert.equal(after.text, `${LINE_A}why`, `the repaint drew the reader's draft back (got ${JSON.stringify(after.text)})`);
  assert.equal(after.draft, `${LINE_A}why`, "from the draft store, so the words were never only in the old node");
  // The caret: the rebuilt box takes the next keystroke at the end of the sentence, not at its start.
  await page.locator(boxSel(2, THREAD_2)).click();
  await page.keyboard.press("End");
  await page.keyboard.type("?");
  await page.waitForTimeout(150);
  const typed = await readAsk(2, THREAD_2);
  assert.equal(typed.text, `${LINE_A}why?`, `typing after the repaint appends to the end (got ${JSON.stringify(typed.text)})`);
});

// ---- ask 4: a real state poll ---------------------------------------------------------------------------------
it("a state snapshot keeps the line, the focus and the caret", async () => {
  const gen = await nextSnapshot();
  const after = await readAsk(2, THREAD_2);
  ledger.cases.polled = { ...after, snapshotGeneration: gen };
  assert.equal(after.text, `${LINE_A}why?`, `the snapshot left the line where it was (got ${JSON.stringify(after.text)})`);
  assert.equal(after.draft, `${LINE_A}why?`, "and the draft store still holds it");
  await page.locator(boxSel(2, THREAD_2)).click();
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await page.waitForTimeout(150);
  const typed = await readAsk(2, THREAD_2);
  assert.equal(typed.text, `${LINE_A}why?!`, `typing after the poll appends to the end (got ${JSON.stringify(typed.text)})`);
  assert.equal(sawSay.length, 0, "a poll sends nothing");
});

// ---- ask 5: an EXPANDED tasks fold, and the other assistant ----------------------------------------------
it("[expanded tasks fold] the press still lands on the right assistant, and the line replaces that box's words", async () => {
  await openCard(ID_A);
  // Open the tasks fold under Assistant #1's row: the press now lands in a row whose own list is drawn below it.
  const fold = `#as-initiatives [data-init-card="${ID_A}"] [data-init-task-fold="${ID_A}::assistant-1"]`;
  await page.click(fold);
  await page.waitForSelector(`#as-initiatives [data-init-card="${ID_A}"] [data-init-tasks]`, { timeout: 15_000 });
  assert.equal(
    await page.evaluate((sel) => document.querySelector(sel)?.getAttribute("aria-expanded") === "true", fold),
    true,
    "the row's tasks list is open when the name is pressed",
  );
  await pressRow(ID_A, "assistant-1");
  await page.waitForSelector("#as-assistant-1:not(.hidden)", { timeout: 25_000 });
  await page.waitForTimeout(350);
  const ask = await readAsk(1, THREAD_1);
  ledger.cases.expanded = ask;
  assert.equal(ask.tabOn && ask.chatShown, true, "Assistant #1's tab and Chat are on screen");
  assert.equal(ask.otherPaneHidden, true, "Assistant #2's pane is not");
  assert.equal(ask.text, LINE_A, `#1's box holds exactly Alpha's line (got ${JSON.stringify(ask.text)})`);
  assert.equal(ask.draft, LINE_A, "and it is #1's own thread draft that holds it");
  assert.equal(ask.focused, true, "focused, caret ready");
  // The other assistant's box is untouched: a press writes ONE assistant's draft.
  const other = await readAsk(2, THREAD_2);
  assert.equal(other.text, `${LINE_A}why?!`, "Assistant #2's draft is exactly as the reader left it");
  assert.equal(sawSay.length, 0, "the press posted nothing");
  await shot("2-expanded-fold-other-assistant");
});

// ---- ask 6: a second press from ANOTHER initiative replaces the line ------------------------------------
it("a second press from another initiative replaces the line instead of stacking two", async () => {
  await openCard(ID_B);
  await pressRow(ID_B, "assistant-1");
  await page.waitForSelector("#as-assistant-1:not(.hidden)", { timeout: 25_000 });
  await page.waitForTimeout(350);
  const ask = await readAsk(1, THREAD_1);
  ledger.cases.replaced = ask;
  assert.equal(ask.text, LINE_B, `the box holds Beta's line and only Beta's (got ${JSON.stringify(ask.text)})`);
  assert.equal((ask.text.match(/Question about/g) || []).length, 1, "one question, not two stacked");
  assert.equal(ask.text.includes("\n"), false, "no second line was added under the first");
  assert.equal(ask.draft, LINE_B, "the draft store was replaced with it, so no repaint can bring Alpha's back");
  assert.equal(ask.focused, true, "the caret is in the box, after the colon and space");

  // ...and it is still one line after a real snapshot and a rebuild: nothing replays the old sentence from a mirror.
  await nextSnapshot();
  await page.evaluate((thread) => window.__assistantRenderChat(thread), THREAD_1);
  await page.waitForTimeout(400);
  const after = await readAsk(1, THREAD_1);
  ledger.cases.replacedAfterRepaint = after;
  assert.equal(after.text, LINE_B, `a poll and a repaint keep the replaced line (got ${JSON.stringify(after.text)})`);
  await shot("3-second-initiative-replaced");
});

// ---- ask 7: nothing was ever sent ---------------------------------------------------------------------
it("no press, keystroke, poll or repaint sent anything", async () => {
  assert.deepEqual(sawSay, [], "no POST to /api/assistant/say for the whole run");
  const end = await readAsk(1, THREAD_1);
  assert.equal(end.jobs, 1, "the thread still has the one fixture turn it had - no message was posted");
  assert.equal(end.text, LINE_B, "and the reader's line is still in the box, unsent");
});

// ---- health -------------------------------------------------------------------------------------------
it("the run left no page or console error behind", async () => {
  assert.deepEqual(pageErrors.map(String), [], "no page errors");
  assert.deepEqual(consoleErrors.map(String), [], "no console errors");
});
