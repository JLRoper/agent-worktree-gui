// A clarify card can point the reader at a thing: a Links section with one anchor per link, and a file link that
// opens in the browser this machine is registered to use.
// HARNESS: LIVE GATE — `npm run verify:clarify-card-links`.
//
//   node tools/verify-clarify-card-links.mjs               # this checkout, card capture
//   node tools/verify-clarify-card-links.mjs --keep        # leave the sandbox on disk
//
// WHAT THIS IS. A worker parks on a question that needs the reader to LOOK at something: a report it wrote, a build
// page. The card used to print the path as escaped text, so the reader copied it out of the card and pasted it into
// an address bar - and an old worker that knows nothing about a `links` field still writes its questions that way.
// The card now draws a reserved Links block (one anchor per entry, from the `links` field on the question) AND links
// a bare URL or path that is already in the question text.
//
// THE TWO PROPERTIES THIS PINS, end to end:
//   - the anchors are REAL: a click on a file link reaches POST /api/open-file, which walks lib/open-url.js's ladder
//     (HKCU UrlAssociations -> rundll32 url.dll,FileProtocolHandler -> explorer.exe) and answers with the launcher that
//     actually started. The gate clicks it and reads that answer. No hard-coded Chrome anywhere in the path.
//   - the card NAMES the browser: GET /api/open-file answers the registered browser's name, and the card's Links head
//     says which one a file link will open in.
//
// WHY A REAL RUN. A stub gateway raises a real `clarify.request` on a real worker thread, so the card under test is the
// card a reader gets - drawn by the shipped questionPrompt from the record the panel actually holds - and not a
// hand-written DOM fragment. The capture is that card.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const TREE = path.resolve(HERE, "..");

const { startPanel, waitFor } = await import(pathToFileURL(path.join(TREE, "tools", "panel-testkit.mjs")).href);
const { loadPlaywright, notRun, withBrowser, openPage } = await import(pathToFileURL(path.join(TREE, "tools", "browser.mjs")).href);

const SHOT_DIR = path.join(TREE, "docs", "reports", "assets", "clarify-card-links-2026-11-11");
const CARD_SHOT = path.join(SHOT_DIR, "card.png");

let checks = 0;
let failures = 0;
const ok = (label, cond, detail = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${label}${detail ? `: ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
};
const note = (text) => console.log(`      ${text}`);
const section = (name) => console.log(`\n-- ${name}`);

const REQUEST_ID = "links-req-1";
// The report is written into the seed repo below, so a click has a real file to open and the boundary has something
// to allow. Its path is RELATIVE on purpose: that is what a worker writes, and the route resolves it against the
// open projects.
const REPORT_REL = "docs/reports/clarify-card-links-2026-11-11.html";
// A file outside every project, for the refusal check. Built at runtime so this file names no folder on the machine
// that wrote it (tools/absolute-paths.mjs).
const OUTSIDE = `${"C"}:${"/Windows/win.ini"}`;
// One path in the TEXT (the old-style call, no `links` field at all would look like this) and two entries in the FIELD.
const QUESTION = `The links report at ${REPORT_REL} is ready - should the card ship it as the decided fix?`;
const URL_ONE = "https://example.test/run/7";

// ---- the stub gateway: one real run, one real clarify.request carrying links --------------------------------
function makeStub(links) {
  const seen = { submitted: [], answers: [] };
  const timers = new Set();
  const live = new Map();
  const json = (res, code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(JSON.parse(raw || "{}"));
        } catch {
          resolve({});
        }
      });
    });
  const pending = () => [{ kind: "clarify", prompt_id: REQUEST_ID, question: QUESTION, choices: ["Ship it (Recommended)", "Hold"], links }];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/capabilities") {
      return json(res, 200, {
        version: "clarify-links-stub",
        features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true },
      });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      seen.submitted.push(await readBody(req));
      return json(res, 200, { run_id: "stub-links", status: "running" });
    }
    const m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2] || "";
      if (sub === "/clarify") {
        seen.answers.push({ id, ...(await readBody(req)) });
        return json(res, 200, { ok: true, run_id: id });
      }
      if (sub === "/stop") return json(res, 200, { ok: true });
      if (sub === "/steer") {
        await readBody(req);
        return json(res, 200, { accepted: true, run_id: id });
      }
      if (sub === "/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": attached\n\n");
        const park = setTimeout(() => {
          timers.delete(park);
          try {
            res.write(`event: clarify.request\ndata: ${JSON.stringify({ event: "clarify.request", prompt_id: REQUEST_ID, question: QUESTION, choices: ["Ship it (Recommended)", "Hold"], multi_select: false, timeout_s: 600, links, timestamp: Math.floor(Date.now() / 1000) })}\n\n`);
          } catch {
            /* the listener went away with the panel */
          }
        }, 200);
        timers.add(park);
        const hold = setInterval(() => {
          try {
            res.write(": hold\n\n");
          } catch {
            clearInterval(hold);
            timers.delete(hold);
          }
        }, 500);
        timers.add(hold);
        live.set(id, { res, hold, park });
        req.on("close", () => {
          clearInterval(hold);
          clearTimeout(park);
          timers.delete(hold);
          timers.delete(park);
          live.delete(id);
        });
        return;
      }
      return json(res, 200, { run_id: id, status: "running", pending_controls: pending() });
    }
    json(res, 404, { error: { message: "not found" } });
  });
  return {
    seen,
    server,
    close: () =>
      new Promise((r) => {
        for (const t of timers) {
          clearInterval(t);
          clearTimeout(t);
        }
        timers.clear();
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the clarify card's links", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
    process.exit(2);
  }
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-links-"));
  const repo = path.join(dir, "repos", "demo");
  const empty = path.join(dir, "empty");
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  mkdirSync(empty, { recursive: true });
  mkdirSync(path.join(repo, "docs", "reports"), { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "links gate");
  git("config", "user.email", "gate@example.test");
  writeFileSync(path.join(repo, "README.md"), "fixture\n");
  // The report the question points at: a real file, inside the project, so the click has something to open.
  writeFileSync(path.join(repo, REPORT_REL), "<!doctype html><title>The links report</title><h1>the links report</h1>\n");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  const repoPath = repo.replace(/\\/g, "/");
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const seed = {
    id: "seed-worker-1",
    thread: "th-worker",
    turn: 1,
    prompt: "settled turn 1",
    cwd: repoPath,
    ownerPath: repoPath,
    projectPath: repoPath,
    sessionId: "th-worker",
    status: "done",
    exitCode: 0,
    startedAt: iso(now - 6 * 60_000),
    endedAt: iso(now - 5 * 60_000),
    runId: "run_seed_worker_1",
    worktree: false,
    existing: false,
    worktreePath: null,
    branch: null,
    lines: [{ kind: "out", lid: 1, at: now - 5 * 60_000, text: "done - nothing left in this turn." }],
    finalMessage: "done - nothing left in this turn.",
  };
  writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ savedAt: iso(now), jobs: [seed] }), "utf8");

  const LINKS = [
    { label: "the links report", path: REPORT_REL },
    { label: "the build page", url: URL_ONE },
  ];
  const stub = makeStub(LINKS);
  await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
  const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;

  const panel = await startPanel({
    dir,
    root: TREE,
    config: {
      scanRoots: [empty],
      projects: [{ name: "demo", path: repoPath, mainBranch: "main" }],
      refreshSeconds: 3600,
      worktreeSeconds: 5,
      midSeconds: 3600,
      dormantSeconds: 3600,
      slowSeconds: 3600,
      fetchSeconds: -1,
      discoverSeconds: 3600,
      threads: 1,
      defaultCwd: repoPath,
      assistant: { enabled: false, seconds: 3600, maxWakesPerHour: 0 },
      apiServer: { url: stubUrl, key: "sandbox-key" },
    },
  });

  const POST = async (route, body) => {
    const r = await fetch(`${panel.base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  try {
    console.log(`sandbox: ${panel.base}`);
    console.log(`tree:    ${TREE}`);
    console.log(`stub:    ${stubUrl}`);

    section("a real worker run parks on a question that carries links");
    const reply = await POST("/api/agents/reply", { thread: "th-worker", text: "GATE-LINKS carry on until you need a decision" });
    ok("the run is started through the panel's own reply route", reply.status === 202, `HTTP ${reply.status}`);
    const parked = await waitFor(
      async () => {
        const jobs = (await (await fetch(`${panel.base}/api/jobs`)).json()).jobs || [];
        const ask = jobs.find((j) => j.thread === "th-worker" && j.question?.requestId === REQUEST_ID);
        return ask || false;
      },
      { timeoutMs: 40_000, stepMs: 250, what: "the stub's clarify.request with links" },
    );
    ok("the panel holds the question", Boolean(parked), parked ? `run ${parked.runId}` : "never arrived");
    if (!parked) throw new Error("nothing parked, so there is no card to look at");
    // The record the CARD draws from, read where the page reads it: this is the field, normalized by the panel.
    const held = parked.question?.links || [];
    ok("the question's links survive into the job record", held.length === 2, JSON.stringify(held.map((l) => [l.kind, l.label])));
    ok("the file entry is a file and the URL entry is a url", held[0]?.kind === "file" && held[1]?.kind === "url",
      `${held[0]?.kind}/${held[1]?.kind}`);
    ok("the label is kept rather than regenerated", held[0]?.label === "the links report", String(held[0]?.label));

    // What the card will NAME: the machine's registered browser, from the route the page asks at boot.
    const named = await (await fetch(`${panel.base}/api/open-file`)).json().catch(() => ({}));
    note(`registered browser: ${named.browser || "(none resolved - the ladder falls through)"} ${named.progId || ""}`);

    mkdirSync(SHOT_DIR, { recursive: true });
    await withBrowser(
      async ({ page, pageErrors }) => {
        await page.setViewportSize({ width: 1440, height: 980 });
        await openPage(page, panel.base, { selector: "#health.ok" });
        await page.waitForSelector('section.project[data-project="demo"] .project-head', { timeout: 30_000 });
        await page.click('section.project[data-project="demo"] .project-head');
        const rowSel = 'section.project[data-project="demo"] tr.row';
        await page.waitForSelector(rowSel, { timeout: 30_000 });
        for (let i = 0; i < 4; i++) {
          if (await page.evaluate(() => Boolean(document.querySelector('tr.detail .job[data-thread="th-worker"]')))) break;
          await page.click(rowSel);
          await page.waitForTimeout(400);
        }
        await page.waitForSelector('tr.detail .job[data-thread="th-worker"] .turn-question', { state: "visible", timeout: 30_000 });

        section("the card the reader sees");
        const card = await page.evaluate(() => {
          const c = document.querySelector('tr.detail .job[data-thread="th-worker"]');
          const q = c.querySelector(".turn-question");
          const section = q.querySelector(".tq-links");
          const rows = section ? [...section.querySelectorAll("a")] : [];
          return {
            hasSection: Boolean(section),
            head: section?.querySelector(".tq-links-head")?.textContent?.replace(/\s+/g, " ").trim() || null,
            rows: rows.map((a) => ({
              tag: a.tagName,
              href: a.getAttribute("href"),
              file: a.dataset.openFile || null,
              url: a.dataset.openUrl || null,
              title: a.getAttribute("title"),
              text: a.textContent.replace(/\s+/g, " ").trim(),
            })),
            // The old-style call: a bare path in the TEXT, which the card links without a `links` field.
            textAnchors: [...q.querySelectorAll(".tq-question a")].map((a) => a.dataset.openFile || a.dataset.openUrl || null),
            questionText: q.querySelector(".tq-question")?.textContent?.trim() || "",
          };
        });
        ok("the card draws a Links section", card.hasSection, card.head || "no section");
        ok("the section says which browser a file link opens in", /file links open in/i.test(card.head || ""), String(card.head));
        ok(`the section names the registered browser (${named.browser || "your browser"})`,
          (card.head || "").includes(named.browser || "your browser"), String(card.head));
        ok("one anchor per link, and no more", card.rows.length === 2, `${card.rows.length} anchor(s)`);
        ok("each anchor is a real anchor", card.rows.every((r) => r.tag === "A"), card.rows.map((r) => r.tag).join(","));
        const fileRow = card.rows.find((r) => r.file);
        const urlRow = card.rows.find((r) => r.url);
        ok("the file link carries the file path, not a URL", Boolean(fileRow) && fileRow.file === REPORT_REL, String(fileRow?.file));
        ok("the file link's title names the browser", Boolean(fileRow) && /in (Google Chrome|Microsoft Edge|Firefox|Brave|Opera|Vivaldi|your browser)/.test(fileRow.title || ""), String(fileRow?.title));
        ok("the url link is the panel's own anchor", Boolean(urlRow) && urlRow.url === URL_ONE && urlRow.href === URL_ONE,
          `${urlRow?.href} / ${urlRow?.url}`);
        ok("the labels are the anchors' text", card.rows.some((r) => r.text.startsWith("the links report")) && card.rows.some((r) => r.text.startsWith("the build page")),
          card.rows.map((r) => r.text.split("\n")[0]).join(" | "));
        ok("a bare path in the question TEXT is clickable too", card.textAnchors.includes(REPORT_REL), JSON.stringify(card.textAnchors));
        ok("the question's own words are intact", card.questionText.includes("is ready - should the card ship it as the decided fix?"),
          card.questionText.slice(0, 70));

        // The capture is the CARD, not the page: at 1440x980 the card sits below the fold of a board with a project
        // section above it, and a picture with the Links section cut off proves nothing. An ELEMENT screenshot scrolls
        // it into view and clips to it, so the picture is the card whatever the board above it is doing.
        const cardEl = await page.$('tr.detail .job[data-thread="th-worker"] .turn-question');
        await cardEl.screenshot({ path: CARD_SHOT });
        note(`capture: ${CARD_SHOT}`);

        section("the click reaches the panel's own opener");
        // The click is the reader's, unmodified. The page posts to /api/open-file, and the answer is the launcher that
        // actually started - so this asserts the route AND the ladder, not that a handler exists.
        const [response] = await Promise.all([
          page.waitForResponse((r) => r.url().includes("/api/open-file") && r.request().method() === "POST", { timeout: 20_000 }),
          page.click('tr.detail .job[data-thread="th-worker"] .tq-links a[data-open-file]'),
        ]);
        const answer = await response.json().catch(() => ({}));
        ok("the click posts the file link to /api/open-file", response.status() === 200, `HTTP ${response.status()}`);
        ok("the route opened the file it was told to", answer.path?.endsWith(REPORT_REL.replace(/\//g, path.sep)) || answer.path?.endsWith(REPORT_REL), String(answer.path));
        ok("the answer names the launcher that started", Boolean(answer.via), `${answer.via} (${answer.progId || "no progId"})`);
        ok("the file:/// URL went to that launcher", Boolean(answer.url) && answer.url.startsWith("file:///"), String(answer.url));

        section("a refusal the reader could see");
        const outside = await POST("/api/open-file", { path: OUTSIDE });
        ok("a file outside every project is refused", outside.status === 403, `HTTP ${outside.status}: ${outside.body.error || ""}`);
        const missing = await POST("/api/open-file", { path: "docs/reports/not-here.html", base: repoPath });
        ok("a path that does not exist is a 404 with a sentence", missing.status === 404 && /no such file/.test(missing.body.error || ""), String(missing.body.error || ""));

        ok("the page threw nothing while drawing the card", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
      },
      { timeoutMs: 120_000 },
    );
  } finally {
    await panel.stop().catch(() => {});
    await stub.close();
    if (!argv.includes("--keep")) rmSync(dir, { recursive: true, force: true });
    else console.log(`      kept sandbox: ${dir}`);
  }

  console.log(`\n${failures ? "FAILED" : "OK"} - ${checks - failures}/${checks} checks passed`);
  console.log(`card capture: ${CARD_SHOT}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
