// A clarify card's file link must resolve against the tree the QUESTION came from.
// HARNESS: LIVE GATE - `npm run verify:clarify-card-base`.
//
//   node tools/verify-clarify-card-base.mjs               # this checkout, one browser launch
//   node tools/verify-clarify-card-base.mjs --keep        # leave the sandbox on disk
//
// WHAT THIS IS. A worker card parked on a question that named `docs/reports/<file>.html` as bare relative text.
// The card drew an anchor (a relative path looked clickable), the reader clicked it, and POST /api/open-file
// resolved the path against the open PROJECTS - the checkouts - so the panel went looking in the project's own
// tree while the run that asked the question was sitting in a WORKTREE of it. The file was there; the panel said
// no such file, and the reader read a 404 banner over a link the card had promised would open.
//
// WHY A REAL RUN. A stub gateway raises a real `clarify.request` on a real worker thread whose cwd is a linked
// worktree, so the card under test is the card a reader gets, drawn by the shipped questionPrompt from the record
// the panel actually holds. This file reproduces the 21:18Z card's shape rather than describing it.
//
// THE PROPERTIES THIS PINS:
//   - the question record carries the asking turn's tree as `base`, and the anchor the card draws carries it
//     (data-open-file-base), so the POST names the base instead of the panel guessing one;
//   - the click reaches lib/open-url.js's ladder with the file IN the worktree, and the answer says which
//     launcher started it - the reader's own browser, named;
//   - a relative target with no base is refused with a sentence, and a relative target under the wrong base
//     names the path it looked for - never another project's root.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const TREE = path.resolve(HERE, "..");

const { startPanel, waitFor } = await import(pathToFileURL(path.join(TREE, "tools", "panel-testkit.mjs")).href);
const { loadPlaywright, notRun, withBrowser, openPage } = await import(pathToFileURL(path.join(TREE, "tools", "browser.mjs")).href);

const SHOT_DIR = path.join(TREE, "docs", "reports", "assets", "clarify-card-relative-2026-11-11");
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

const REQUEST_ID = "base-req-1";
// The exact shape a worker card used at 21:18Z: a bare relative path inside the question text, no `links` field.
// The file exists ONLY in the run's worktree - the checkout has no docs/reports at all - which is what makes the
// wrong base visible instead of lucky.
const REL = "docs/reports/rebuild-phase_status.html";
const QUESTION = `The rebuild status report at ${REL} finds phase 0 is 1 of 4 with no Java code yet, so which direction do you want next: (1) baseline the oracle by running the 113 donor tests and recording pass/fail, (2) close phase 0 by recording D1-D8 and landing openapi.yaml as contract v1, (3) cut the phase-1 container-api skeleton with one module and one JUnit test, or (4) stop at the report?`;
const URL_ONE = "https://example.test/run/8";

// ---- the stub gateway: one real run, one real clarify.request carrying a relative path -----------------------
function makeStub() {
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
  const pending = () => [{ kind: "clarify", prompt_id: REQUEST_ID, question: QUESTION, choices: ["Baseline the oracle (Recommended)", "Stop at the report"] }];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/capabilities") {
      return json(res, 200, {
        version: "clarify-base-stub",
        features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true },
      });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      seen.submitted.push(await readBody(req));
      return json(res, 200, { run_id: "stub-base", status: "running" });
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
            res.write(
              `event: clarify.request\ndata: ${JSON.stringify({
                event: "clarify.request",
                prompt_id: REQUEST_ID,
                question: QUESTION,
                choices: ["Baseline the oracle (Recommended)", "Stop at the report"],
                multi_select: false,
                timeout_s: 600,
                timestamp: Math.floor(Date.now() / 1000),
              })}\n\n`,
            );
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
    console.log(notRun("the clarify card's relative path", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
    process.exit(2);
  }
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-base-"));
  const repo = path.join(dir, "repos", "demo");
  const wt = path.join(repo, ".worktrees", "report-one");
  const empty = path.join(dir, "empty");
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  mkdirSync(empty, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "base gate");
  git("config", "user.email", ["base", "gate.local"].join(String.fromCharCode(64)));
  writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  // The worktree the run works in, and the report that exists ONLY there. The checkout deliberately has no
  // docs/reports directory: a resolver that guesses a project root cannot find this file by accident.
  git("worktree", "add", "-q", "-b", "work/report-one", wt.replace(/\\/g, "/"));
  mkdirSync(path.join(wt, "docs", "reports"), { recursive: true });
  writeFileSync(path.join(wt, REL), "<!doctype html><title>The rebuild status report</title><h1>phase 0: 1 of 4</h1>\n");
  if (!existsSync(path.join(wt, REL))) throw new Error("fixture report was not written");

  const repoPath = repo.replace(/\\/g, "/");
  const wtPath = wt.replace(/\\/g, "/");
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const seed = {
    id: "seed-worker-1",
    thread: "th-worker",
    turn: 1,
    prompt: "settled turn 1",
    cwd: wtPath,
    ownerPath: wtPath,
    projectPath: repoPath,
    sessionId: "th-worker",
    status: "done",
    exitCode: 0,
    startedAt: iso(now - 6 * 60_000),
    endedAt: iso(now - 5 * 60_000),
    runId: "run_seed_worker_1",
    worktree: true,
    existing: false,
    worktreePath: wtPath,
    branch: "work/report-one",
    lines: [{ kind: "out", lid: 1, at: now - 5 * 60_000, text: "done - nothing left in this turn." }],
    finalMessage: "done - nothing left in this turn.",
  };
  writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ savedAt: iso(now), jobs: [seed] }), "utf8");

  const stub = makeStub();
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
    console.log(`worktree: ${wtPath}`);
    console.log(`stub:    ${stubUrl}`);

    section("a real worker run, in a worktree, parks on a question carrying a relative path");
    const reply = await POST("/api/agents/reply", { thread: "th-worker", text: "GATE-BASE carry on until you need a decision" });
    ok("the run is started through the panel's own reply route", reply.status === 202, `HTTP ${reply.status}`);
    const parked = await waitFor(
      async () => {
        const jobs = (await (await fetch(`${panel.base}/api/jobs`)).json()).jobs || [];
        const ask = jobs.find((j) => j.thread === "th-worker" && j.question?.requestId === REQUEST_ID);
        return ask || false;
      },
      { timeoutMs: 40_000, stepMs: 250, what: "the stub's clarify.request with the relative path" },
    );
    ok("the panel holds the question", Boolean(parked), parked ? `run ${parked.runId}` : "never arrived");
    if (!parked) throw new Error("nothing parked, so there is no card to look at");
    ok("the run's cwd is the worktree, not the checkout", String(parked.cwd || "").replace(/\\/g, "/") === wtPath, String(parked.cwd));
    ok(
      "the question carries the asking turn's tree as its base",
      String(parked.question?.base || "").replace(/\\/g, "/") === wtPath,
      String(parked.question?.base || "(no base on the question record)"),
    );

    const named = await (await fetch(`${panel.base}/api/open-file`)).json().catch(() => ({}));
    note(`registered browser: ${named.browser || "(none resolved - the ladder falls through)"} ${named.progId || ""}`);

    mkdirSync(SHOT_DIR, { recursive: true });
    await withBrowser(
      async ({ page, pageErrors }) => {
        await page.setViewportSize({ width: 1440, height: 980 });
        await openPage(page, panel.base, { selector: "#health.ok" });
        await page.waitForSelector('section.project[data-project="demo"] .project-head', { timeout: 30_000 });
        await page.click('section.project[data-project="demo"] .project-head');
        // The board keys a row `${project}::${path}` (public/core/dom-format.js keyOf), and the tree under test is
        // the worktree the run is in - not the project's own checkout.
        const rowSel = `tr.row[data-key="demo::${wtPath}"]`;
        try {
          await page.waitForSelector(rowSel, { timeout: 30_000 });
        } catch (e) {
          const rows = ((await (await fetch(`${panel.base}/api/state`)).json()).rows || []).map((r) => r.path);
          const dom = await page.evaluate(() => [...document.querySelectorAll("tr.row[data-key]")].map((tr) => tr.dataset.key));
          note(`state rows: ${JSON.stringify(rows)}`);
          note(`dom row keys: ${JSON.stringify(dom)}`);
          throw e;
        }
        await page.click(rowSel);
        await page.waitForSelector('tr.detail .job[data-thread="th-worker"] .turn-question', { state: "visible", timeout: 30_000 });

        section("the card the reader sees");
        const card = await page.evaluate(() => {
          const c = document.querySelector('tr.detail .job[data-thread="th-worker"]');
          const q = c.querySelector(".turn-question");
          const anchors = [...q.querySelectorAll(".tq-question a[data-open-file]")];
          const noteEl = q.querySelector(".tq-relnote");
          return {
            anchors: anchors.map((a) => ({
              file: a.dataset.openFile || null,
              base: a.dataset.openFileBase || null,
              title: a.getAttribute("title"),
              text: a.textContent.trim(),
            })),
            note: noteEl ? noteEl.textContent.replace(/\s+/g, " ").trim() : null,
            questionText: q.querySelector(".tq-question")?.textContent?.replace(/\s+/g, " ").trim() || "",
          };
        });
        ok("the question's relative path is drawn as an anchor", card.anchors.length === 1, `${card.anchors.length} anchor(s)`);
        ok("the anchor's target is the path the worker wrote", card.anchors[0]?.file === REL, String(card.anchors[0]?.file));
        ok(
          "the anchor carries the asking turn's tree, so the click cannot resolve anywhere else",
          String(card.anchors[0]?.base || "").replace(/\\/g, "/") === wtPath,
          String(card.anchors[0]?.base || "(no data-open-file-base: the request carries no base)"),
        );
        ok("the anchor's title names the browser it will open in", /in (Google Chrome|Microsoft Edge|Firefox|Brave|Opera|Vivaldi|your browser)/.test(card.anchors[0]?.title || ""), String(card.anchors[0]?.title));
        ok("the question's own words are intact", card.questionText.includes("which direction do you want next"), card.questionText.slice(0, 80));

        const cardEl = await page.$('tr.detail .job[data-thread="th-worker"] .turn-question');
        await cardEl.screenshot({ path: CARD_SHOT });
        note(`capture: ${CARD_SHOT}`);

        section("the click, where the panel looks, and what the reader sees");
        // The click is the reader's, unmodified. The POST body is recorded from the wire, so the base is proven to
        // travel in the request rather than being reconstructed by the route.
        let posted = null;
        page.on("request", (r) => {
          if (r.method() === "POST" && r.url().includes("/api/open-file")) {
            try {
              posted = r.postDataJSON();
            } catch {
              posted = null;
            }
          }
        });
        const [response] = await Promise.all([
          page.waitForResponse((r) => r.url().includes("/api/open-file") && r.request().method() === "POST", { timeout: 20_000 }),
          page.click('tr.detail .job[data-thread="th-worker"] .tq-question a[data-open-file]'),
        ]);
        const answer = await response.json().catch(() => ({}));
        await page.waitForTimeout(600);
        const banner = await page.evaluate(() => {
          const b = document.getElementById("banner");
          const visible = b && !b.classList.contains("hidden");
          return { visible: Boolean(visible), text: document.getElementById("banner-text")?.textContent?.trim() || "" };
        });
        note(`POST body:    ${JSON.stringify(posted)}`);
        note(`route answer:  HTTP ${response.status()} ${JSON.stringify(answer)}`);
        note(`reader banner: ${banner.visible ? banner.text : "(none)"}`);
        ok("the click posts the path AND the base the card carries", posted?.path === REL && String(posted?.base || "").replace(/\\/g, "/") === wtPath, JSON.stringify(posted));
        ok("the click opens the file", response.status() === 200, `HTTP ${response.status()} ${answer.error || ""}`);
        ok(
          "the file it opened is the one in the asking turn's worktree",
          String(answer.path || "").replace(/\\/g, "/") === `${wtPath}/${REL}`,
          String(answer.path || "(no path in the answer)"),
        );
        ok("the answer names the launcher that started", Boolean(answer.via), `${answer.via || "(none)"} (${answer.progId || "no progId"})`);
        ok("the file:/// URL went to that launcher", String(answer.url || "").startsWith("file:///") && decodeURIComponent(String(answer.url || "")).replace(/\\/g, "/").endsWith(`${wtPath}/${REL}`), String(answer.url || "(none)"));
        const browserExe = named.bin ? path.basename(String(named.bin)).toLowerCase() : null;
        ok("the answer names the reader's registered browser", browserExe ? String(answer.opener || "").toLowerCase() === browserExe : Boolean(answer.opener), `${answer.opener || "(none)"} vs ${named.browser || "your browser"}`);
        ok("the reader saw no failure banner", !banner.visible, banner.text || "(none)");
        ok("the page threw nothing while drawing the card and clicking it", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

        section("a base that is missing or wrong is refused, never guessed");
        const noBase = await POST("/api/open-file", { path: REL });
        ok("a relative path with no base is a 400 that says so", noBase.status === 400 && /base/i.test(noBase.body.error || ""), `HTTP ${noBase.status}: ${noBase.body.error || ""}`);
        const wrongBase = await POST("/api/open-file", { path: REL, base: repoPath });
        ok(
          "the wrong base names the path it looked for there",
          wrongBase.status === 404 && String(wrongBase.body.error || "").replace(/\\/g, "/").includes(`${repoPath}/${REL}`),
          `HTTP ${wrongBase.status}: ${wrongBase.body.error || ""}`,
        );
        const outside = await POST("/api/open-file", { path: "win.ini", base: `${"C"}:${"/Windows"}` });
        ok("a base outside every project cannot smuggle a file out", outside.status === 403, `HTTP ${outside.status}: ${outside.body.error || ""}`);

        section("the old-style call is unchanged where it was already resolvable");
        const abs = await POST("/api/open-file", { path: `${wtPath}/${REL}` });
        ok("an absolute path still opens without a base", abs.status === 200 && String(abs.path || abs.body.path || "").replace(/\\/g, "/") === `${wtPath}/${REL}`, `HTTP ${abs.status} ${abs.body.path || abs.body.error || ""}`);
        const url = await POST("/api/open-url", { url: URL_ONE });
        ok("a URL still goes to the OS opener", url.status === 200, `HTTP ${url.status} ${url.body.error || ""}`);
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
