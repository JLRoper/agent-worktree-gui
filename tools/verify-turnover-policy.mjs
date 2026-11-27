// tools/verify-turnover-policy.mjs - the turnover bar's POLICY select, beside the kind and the branch.
//
//   node tools/verify-turnover-policy.mjs
//   PANEL_SHOTS_DIR=docs/assets/turnover-policy-bar node tools/verify-turnover-policy.mjs
//
// WHAT THIS IS. A project's turnover policy is one of free | ask | one-per-feature (default ask), read by
// lib/project-turnover.js and served by GET /api/project-turnover?project=<name> as `turnoverPolicy` beside
// `policyLabels` and the `policies` list. Until this landing the page had no control for it: the kind and the branch
// were drawn in the turnover bar (public/board-scaffold.js) and the policy was only reachable by editing config.json
// or POSTing a body by hand. This gate asserts the control the landing adds, and the two halves of the wire shape it
// depends on.
//
// WHAT IS DRIVEN, AND WHY EACH ONE MATTERS
//   1. THE READ: three projects whose config rows carry free, ask and one-per-feature each open a bar whose policy
//      select offers exactly the three ids, in the read's order, with the words from the read's own `policyLabels`
//      (not a copy in the page), and with THAT project's value selected - so the reader sees which policy is in force
//      before touching anything
//   2. THE WORDS COME FROM THE READ, not from the page: a fake GET carrying different labels and a different selected
//      value is drawn as answered - the one check a hardcoded label list could not pass
//   3. THE CHANGE: picking a policy POSTs `{ project, turnoverPolicy }` and NOTHING else. That is the body
//      routes/project-turnover.js accepts as a save of its own, and the body is asserted on the request the browser
//      actually sent, not on the page's source
//   4. THE ANSWER IS WHAT IS DRAWN: a fake 200 answering `ask` to a `free` pick leaves the select reading ask - the
//      bar is repainted from `out.turnoverPolicy`, never from the value the reader chose
//   5. A REFUSAL IS SHOWN: a 400 puts the route's own sentence on the bar's line, verbatim and in the error style,
//      with the select left on the value the server still holds - not a swallowed failure. The sentence used in the
//      fake is the one the REAL route answers to a bad policy, so it is the panel's own words
//   6. A POLICY-ONLY CHANGE DISTURBS NO BRANCH: the project's turnoverBranches read back identical from the route AND
//      from config.json on disk, the branch input keeps its name, and a second policy-only save against the real
//      route answers 200 with the same list - the `value === undefined` half of setProjectTurnover, proved end to end
//   7. the two states of the chip row are photographed: policy before the change (free) and after it (one per
//      feature), plus the refusal, at 1440x900
//   8. no page errors
//
// The panel under test is a SECOND instance on a free port (tools/panel-testkit.mjs `freePort`): three throwaway
// git repositories, each named in config.json with its own turnoverBranches and turnoverPolicy.
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright } from "./browser.mjs";
import { configureRepo, git, startPanel, waitFor } from "./panel-testkit.mjs";

let failures = 0;
let checks = 0;
const check = (name, got, want) => {
  checks += 1;
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (!same) failures += 1;
  console.log(`${same ? "PASS" : "FAIL"}  ${name}${same ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` - ${extra}` : ""}`);
  }
};
const note = (text) => console.log(`      ${text}`);

const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-NOT-RUN  the turnover policy select was not exercised in a browser.");
  console.log("  re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-turnover-policy.mjs");
  process.exit(2);
}

// ---- the sandbox: three projects, one per policy, each with a branch list ---------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-turnover-policy-"));
const repos = path.join(dir, "repos");
mkdirSync(repos, { recursive: true });
const paths = {};
for (const name of ["alpha", "beta", "gamma"]) {
  const repo = path.join(repos, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  configureRepo(repo);
  git(repo, ["commit", "-q", "--allow-empty", "-m", `seed ${name}`]);
  paths[name] = repo.replace(/\\/g, "/");
}
// alpha's list carries a KEY on purpose: the one-per-feature join lives on the entry, and a policy save that rewrote
// the list could drop it without changing the branch names a reader would notice.
const ALPHA_BRANCHES = [{ branch: "20261120_0900_TASK-11_alpha-rollup", key: "task 11" }];
const BETA_BRANCHES = ["feature/beta-rollup"];
const GAMMA_BRANCHES = [];
const PROJECTS = [
  { name: "alpha", path: paths.alpha, mainBranch: "main", turnoverBranches: ALPHA_BRANCHES, turnoverPolicy: "free" },
  { name: "beta", path: paths.beta, mainBranch: "main", turnoverBranches: BETA_BRANCHES, turnoverPolicy: "ask" },
  { name: "gamma", path: paths.gamma, mainBranch: "main", turnoverBranches: GAMMA_BRANCHES, turnoverPolicy: "one-per-feature" },
];

const shotsDir = process.env.PANEL_SHOTS_DIR ? path.resolve(process.cwd(), process.env.PANEL_SHOTS_DIR) : path.join(dir, "shots");
mkdirSync(shotsDir, { recursive: true });

const panel = await startPanel({
  dir,
  config: {
    scanRoots: [repos.replace(/\\/g, "/")],
    projects: PROJECTS,
    sameRepoScan: true,
    scanMode: "all",
    defaultCwd: paths.alpha,
    refreshSeconds: 4,
    worktreeSeconds: 4,
    midSeconds: 8,
    dormantSeconds: 15,
    slowSeconds: 20,
    fetchSeconds: 3600,
    threads: 1,
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
    assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
  },
});
note(`second panel instance on free port ${panel.port} (config ${panel.configPath})`);
const base = panel.base;
const getJson = async (url, opts = undefined) => {
  const r = await fetch(`${base}${url}`, opts);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const postJson = async (body) =>
  getJson("/api/project-turnover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const configOnDisk = () => JSON.parse(readFileSync(panel.configPath, "utf8"));
const diskProject = (name) => (configOnDisk().projects || []).find((p) => p && p.name === name) || null;

let browser = null;
let shots = [];

try {
  // ---- 0: the board, and the three project rows the page will draw ------------------------------------------
  const ready = await waitFor(
    async () => {
      const snap = (await getJson("/api/state")).body;
      const byName = Object.fromEntries((snap.projects || []).map((p) => [p.name, p]));
      // The pre-scan record carries the config row's raw shape (no normalised `turnoverBranch`, string entries). Wait
      // for the FIRST normalised pass, or the chip row this gate photographs is the boot shape rather than the board.
      const scanned =
        byName.alpha?.turnoverBranch === ALPHA_BRANCHES[0].branch &&
        byName.beta?.turnoverBranch === BETA_BRANCHES[0] &&
        Array.isArray(byName.gamma?.turnoverBranches);
      return scanned && ["alpha", "beta", "gamma"].every((n) => byName[n] && byName[n].turnoverPolicy) ? byName : false;
    },
    { timeoutMs: 60_000, what: "the three projects on the board, scanned and carrying their turnoverPolicy" },
  );
  ok("the board carries the three projects with their policy on the project record", Boolean(ready));
  check("the record's policy is the file's: free, ask, one per feature", [ready.alpha.turnoverPolicy, ready.beta.turnoverPolicy, ready.gamma.turnoverPolicy], ["free", "ask", "one-per-feature"]);
  const real = await getJson("/api/project-turnover?project=alpha");
  check("GET /api/project-turnover answers the three policies and their words", [real.body.policies, Object.keys(real.body.policyLabels)], [["free", "ask", "one-per-feature"], ["free", "ask", "one-per-feature"]]);
  const LABELS = real.body.policyLabels;
  note(`policyLabels: ${JSON.stringify(LABELS)}`);

  browser = await pw.chromium.launch({ headless: true }).catch(async (err) => {
    if (!/Executable doesn't exist|headless[_-]shell/i.test(String((err && err.message) || err))) throw err;
    console.log("BROWSER  the headless shell binary is not installed - launching the full chromium build instead");
    return pw.chromium.launch({ headless: true, channel: "chromium" });
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
  page.on("console", (m) => {
    // The refusal section asks for a 400 on purpose, and a browser logs every 4xx as a console error. One 400 for the
    // policy POST is the proof; anything else is still a failure.
    if (m.type() === "error" && !/Failed to load resource: the server responded with a status of 400/.test(m.text())) {
      pageErrors.push(`console.error: ${m.text()}`);
    }
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  const boardUp = await waitFor(async () => (await page.locator("section.project[data-project]").count()) >= 3, { timeoutMs: 60_000, what: "three project sections on the board" });
  ok("the page draws the three project sections", boardUp);
  for (const name of ["alpha", "beta", "gamma"]) {
    const sec = page.locator(`section.project[data-project="${name}"]`);
    const cls = (await sec.getAttribute("class")) || "";
    if (cls.includes("collapsed")) await sec.locator(".project-head[data-toggle-project]").first().click();
  }

  const CHIP = (name) => `button[data-turnover-chip="${name}"]`;
  const BAR = (name) => `[data-turnover-bar="${name}"]`;
  const openBar = async (name) => {
    if ((await page.locator(BAR(name)).count()) === 0) await page.locator(CHIP(name)).click();
    await page.waitForSelector(BAR(name), { timeout: 15_000 });
  };
  const closeBar = async (name) => {
    if ((await page.locator(BAR(name)).count()) === 0) return;
    await page.locator(CHIP(name)).click();
    await page.waitForSelector(BAR(name), { state: "detached", timeout: 15_000 });
  };
  // The select as the reader sees it: the options, the words, the one picked, and the bar's own status line.
  const barState = (name) =>
    page.evaluate((n) => {
      const bar = document.querySelector(`[data-turnover-bar="${n}"]`);
      const sel = bar?.querySelector("[data-turnover-policy]");
      const status = bar?.querySelector("[data-turnover-status]");
      return {
        present: Boolean(bar),
        select: Boolean(sel),
        values: sel ? [...sel.options].map((o) => o.value) : [],
        texts: sel ? [...sel.options].map((o) => o.textContent.replace(/\s+/g, " ").trim()) : [],
        titles: sel ? [...sel.options].map((o) => o.title) : [],
        value: sel?.value || "",
        label: (sel?.closest("label")?.firstChild?.textContent || "").replace(/\s+/g, " ").trim(),
        aria: sel?.getAttribute("aria-label") || "",
        title: sel?.getAttribute("title") || "",
        disabled: Boolean(sel?.disabled),
        status: (status?.textContent || "").replace(/\s+/g, " ").trim(),
        statusError: Boolean(status?.classList.contains("clone-err")),
        branch: bar?.querySelector("[data-turnover-input]")?.value ?? null,
      };
    }, name);
  const waitForLabels = (name, wantFirst) =>
    waitFor(
      async () => {
        const st = await barState(name);
        return st.select && st.texts[0] === wantFirst ? st : false;
      },
      { timeoutMs: 20_000, what: `the policy select for ${name} to draw the read's labels` },
    );

  // ---- 1. THE READ: three projects, three values, the read's own labels --------------------------------------
  const readStates = {};
  for (const [name, policy, branch] of [["alpha", "free", ALPHA_BRANCHES[0].branch], ["beta", "ask", BETA_BRANCHES[0]], ["gamma", "one-per-feature", ""]]) {
    await openBar(name);
    const st = await waitForLabels(name, LABELS.free);
    readStates[name] = st;
    ok(`${name}'s bar has a policy select, drawn with the word "policy"`, Boolean(st && st.select) && st.label === "policy", st?.label);
    check(`${name}'s select tooltip carries the chosen policy's words`, st?.title, LABELS[policy]);
    check(`${name}'s select offers exactly the three policies, in the read's order`, st?.values, ["free", "ask", "one-per-feature"]);
    check(`${name}'s options carry the read's policyLabels verbatim`, st?.texts, [LABELS.free, LABELS.ask, LABELS["one-per-feature"]]);
    check(`${name}'s select has the project's own policy selected`, st?.value, policy);
    ok(`${name}'s select has an accessible name naming the project`, String(st?.aria || "").includes(name), st?.aria);
    check(`${name}'s bar draws its branch field beside the policy`, st?.branch, branch);
  }
  ok("the three bars show three different policies, each from its own project record", new Set(Object.values(readStates).map((s) => s.value)).size === 3);
  // The before picture: the chip row with the select on the project's current policy, branch and kind beside it.
  const shot = async (name, file) => {
    // The chip row and the open bar are two boxes; the union is the picture. The head is scrolled to the top first,
    // because a head above the viewport cannot be captured and the first attempt lost exactly the chip this is about.
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.locator(`section.project[data-project="${name}"] .project-head`).first().scrollIntoViewIfNeeded();
    await page.evaluate((n) => {
      const head = document.querySelector(`section.project[data-project="${n}"] .project-head`);
      const r = head?.getBoundingClientRect();
      // 96px, not 20: the page's own toolbar is sticky over the top of the viewport, and a head scrolled to 20 has its
      // name line drawn UNDER it - the first version of this shot lost exactly that line.
      if (r && r.top < 96) window.scrollBy(0, r.top - 96);
    }, name);
    await page.waitForTimeout(200);
    const clip = await page.evaluate((n) => {
      const sec = document.querySelector(`section.project[data-project="${n}"]`);
      const head = sec?.querySelector(".project-head");
      const bars = sec?.querySelector("[data-bars]");
      const boxes = [head, bars].filter(Boolean).map((el) => el.getBoundingClientRect());
      if (!boxes.length) return null;
      const left = Math.min(...boxes.map((b) => b.left));
      const top = Math.min(...boxes.map((b) => b.top));
      const right = Math.max(...boxes.map((b) => b.right));
      const bottom = Math.max(...boxes.map((b) => b.bottom));
      return { x: Math.max(0, Math.floor(left) - 8), y: Math.max(0, Math.floor(top) - 8), width: Math.ceil(right - left) + 16, height: Math.ceil(bottom - top) + 16 };
    }, name);
    if (!clip) return null;
    const target = path.join(shotsDir, file);
    await page.screenshot({ path: target, clip });
    shots.push(target);
    note(`shot ${target}`);
    return target;
  };
  const beforeShot = await shot("alpha", "turnover-policy-before.png");
  ok("the chip row was photographed with the policy select on its current value", Boolean(beforeShot), beforeShot || "no clip");

  // ---- 2. THE CHANGE: the body the route accepts, and the branch list it must leave alone --------------------
  const before = await getJson("/api/project-turnover?project=alpha");
  const diskBefore = diskProject("alpha");
  const posts = [];
  const answers = [];
  page.on("response", (r) => {
    if (r.url().includes("/api/project-turnover") && r.request().method() === "POST") answers.push({ status: r.status() });
  });
  const TURNOVER_ROUTE = /\/api\/project-turnover/;
  const capturePolicyPosts = async (route) => {
    if (route.request().method() === "GET") return route.continue();
    posts.push(JSON.parse(route.request().postData() || "{}"));
    await route.continue();
  };
  await page.route(TURNOVER_ROUTE, capturePolicyPosts);
  await page.selectOption(`${BAR("alpha")} [data-turnover-policy]`, "one-per-feature");
  const afterChange = await waitFor(
    async () => {
      const st = await barState("alpha");
      return st.value === "one-per-feature" && /turnover policy/i.test(st.status) ? st : false;
    },
    { timeoutMs: 20_000, what: "alpha's bar to redraw on the answered policy" },
  );
  await page.unroute(TURNOVER_ROUTE, capturePolicyPosts);

  check("a change POSTs ONE body: the project and the policy, nothing else", posts, [{ project: "alpha", turnoverPolicy: "one-per-feature" }]);
  check("the route answered the policy-only body with 200", answers.map((a) => a.status), [200]);
  ok("the select redraws on the answered policy", afterChange?.value === "one-per-feature", afterChange?.value);
  ok("the bar's line names the policy it now holds", /one per feature - ask, and refuse a second branch/.test(afterChange?.status || ""), afterChange?.status);
  check("the branch field still shows the project's branch", afterChange?.branch, ALPHA_BRANCHES[0].branch);
  const afterShot = await shot("alpha", "turnover-policy-after.png");
  ok("the chip row was photographed after the change", Boolean(afterShot), afterShot || "no clip");

  const after = await getJson("/api/project-turnover?project=alpha");
  check("the route reads the change back", after.body.turnoverPolicy, "one-per-feature");
  check("a policy-only change leaves turnoverBranches EXACTLY as they were (route)", after.body.turnoverBranches, before.body.turnoverBranches);
  check("...including the key on the entry, which the one-per-feature join lives on", after.body.turnoverBranches?.[0]?.key, "task 11");
  const diskAfter = diskProject("alpha");
  check("...and config.json on disk carries the same list untouched", diskAfter?.turnoverBranches, diskBefore?.turnoverBranches);
  check("...while the policy on disk moved", diskAfter?.turnoverPolicy, "one-per-feature");

  // ---- 3. THE WORDS AND THE VALUE COME FROM THE READ ---------------------------------------------------------
  // A fake read answers different words and a different selected value. A page that hardcoded its labels would draw
  // "free - add a turnover branch without asking" here; a page that draws the read's answer cannot.
  const FAKE_LABELS = { free: "FREE from the read", ask: "ASK from the read", "one-per-feature": "ONE PER FEATURE from the read" };
  const fakeReadHandler = async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        maxChars: 120,
        kinds: ["checkout", "turnover", "local-turnover"],
        kindLabels: {},
        policies: ["free", "ask", "one-per-feature"],
        policyLabels: FAKE_LABELS,
        defaultPolicy: "ask",
        project: "beta",
        turnoverBranch: BETA_BRANCHES[0],
        turnoverBranches: BETA_BRANCHES.map((branch) => ({ branch, key: null })),
        turnoverPolicy: "one-per-feature",
        baseRefKind: "turnover",
      }),
    });
  };
  await page.route(TURNOVER_ROUTE, fakeReadHandler);
  await closeBar("beta");
  await openBar("beta");
  const fakeRead = await waitForLabels("beta", FAKE_LABELS.free);
  check("the select draws the labels the READ answered, not a copy in the page", fakeRead?.texts, [FAKE_LABELS.free, FAKE_LABELS.ask, FAKE_LABELS["one-per-feature"]]);
  check("...and selects the value the READ answered", fakeRead?.value, "one-per-feature");
  await page.unroute(TURNOVER_ROUTE, fakeReadHandler);
  await closeBar("beta");
  await openBar("beta");
  const realAgain = await waitForLabels("beta", LABELS.free);
  check("with the fake gone, beta's bar reads its real policy again", realAgain?.value, "ask");

  // ---- 4. THE REDRAW IS FROM THE ANSWER, NOT FROM THE PICK ---------------------------------------------------
  // The reader picks free; the route answers ask. The bar must read ask - the answer is what the file now holds.
  const answeredHandler = async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        asked: false,
        project: "gamma",
        turnoverBranch: "",
        turnoverBranches: [],
        turnoverPolicy: "ask",
        baseRefKind: "checkout",
        maxChars: 120,
        note: "gamma: no turnover branch",
      }),
    });
  };
  await page.route(TURNOVER_ROUTE, answeredHandler);
  await page.selectOption(`${BAR("gamma")} [data-turnover-policy]`, "free");
  const answered = await waitFor(
    async () => {
      const st = await barState("gamma");
      return st.value === "ask" && /turnover policy/i.test(st.status) ? st : false;
    },
    { timeoutMs: 20_000, what: "gamma's bar to redraw on the answered policy" },
  );
  await page.unroute(TURNOVER_ROUTE, answeredHandler);
  ok("a pick of free answered with ask leaves the select reading ask", answered?.value === "ask", answered?.value);
  ok("...and the bar's line names ask by its label, from the answer", /ask - a new turnover branch waits for your answer/.test(answered?.status || ""), answered?.status);

  // ---- 5. A REFUSAL SHOWS THE ROUTE'S OWN SENTENCE ----------------------------------------------------------
  // The sentence is obtained from the REAL route first, so the string drawn below is the panel's, not this gate's.
  const realRefusal = await postJson({ project: "beta", turnoverPolicy: "nonsense" });
  const SENTENCE = String(realRefusal.body?.error || "");
  check("the real route refuses an unknown policy with 400", realRefusal.status, 400);
  ok("...with the sentence this check will look for on the bar", /^turnoverPolicy must be one of free, ask, one-per-feature$/.test(SENTENCE), SENTENCE);
  const betaBefore = await getJson("/api/project-turnover?project=beta");
  const refusalHandler = async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: SENTENCE }) });
  };
  await page.route(TURNOVER_ROUTE, refusalHandler);
  await page.selectOption(`${BAR("beta")} [data-turnover-policy]`, "one-per-feature");
  const refused = await waitFor(
    async () => {
      const st = await barState("beta");
      return st.status === SENTENCE ? st : false;
    },
    { timeoutMs: 20_000, what: "beta's bar to show the refusal" },
  );
  await page.unroute(TURNOVER_ROUTE, refusalHandler);
  check("a 400 renders the route's sentence VERBATIM on the bar's line", refused?.status, SENTENCE);
  ok("...in the bar's error style, not as an ordinary note", refused?.statusError === true);
  check("...and the select is put back on the value the server still holds", refused?.value, "ask");
  check("...with the branch field untouched by the refusal", refused?.branch, BETA_BRANCHES[0]);
  const refusalShot = await shot("beta", "turnover-policy-refusal.png");
  ok("the refusal was photographed beside the chip", Boolean(refusalShot), refusalShot || "no clip");
  const betaAfterRefusal = await getJson("/api/project-turnover?project=beta");
  check("the refused save wrote nothing: beta's policy is still ask", betaAfterRefusal.body.turnoverPolicy, "ask");
  check("...and its branch list is exactly what it was", betaAfterRefusal.body.turnoverBranches, betaBefore.body.turnoverBranches);

  // ---- 6. A POLICY-ONLY SAVE IS A SAVE: accepted, and it leaves the list alone -------------------------------
  const betaDiskBefore = diskProject("beta");
  const accepted = await postJson({ project: "beta", turnoverPolicy: "one-per-feature" });
  check("POST { project, turnoverPolicy } is accepted as a save of its own", accepted.status, 200);
  check("...answering the policy it stored", accepted.body.turnoverPolicy, "one-per-feature");
  check("...with the branch list unchanged in the answer", accepted.body.turnoverBranches, betaBefore.body.turnoverBranches);
  check("...and unchanged in config.json on disk", diskProject("beta")?.turnoverBranches, betaDiskBefore?.turnoverBranches);

  // ---- 7. no page errors ------------------------------------------------------------------------------------
  check("the page raised no errors", pageErrors, []);
} catch (e) {
  failures += 1;
  console.log(`FAIL  the gate did not finish: ${String((e && e.stack) || e)}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await panel.stop().catch(() => {});
}

console.log("");
console.log(`turnover policy: ${checks - failures} of ${checks} checks passed${failures ? `, ${failures} FAILED` : ""}${shots.length ? `; ${shots.length} shot(s) in ${shotsDir}` : ""}`);
process.exit(failures ? 1 : 0);
