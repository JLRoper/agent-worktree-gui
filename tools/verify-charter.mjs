// The assistant's charter — the continuity file, and the tab that reads it.
//
//   node tools/verify-charter.mjs
//
// The charter exists because the rules and the scratchpad are clipped into the preamble and the Hermes memory
// file is at its budget, so the REASONING behind a convention is what a compaction takes. Four things have to
// hold, and each has its own section below:
//
//   1. the seed      — a panel that has been running for weeks starts the long tier from the rules and notes
//                      it already has, under the prescribed headings, inside the cap
//   2. the briefing  — the whole file is in the run's input on every turn, and the polled state is NOT
//                      (a 20 KB body re-sent on every board event is a cost nobody asked for)
//   3. the writers   — the reader's save, the assistant's `CHARTER:` line and a standing rule changing all
//                      land in the file; the cap and a stale save are refusals, not silent overwrites
//   4. the route     — GET and PUT /api/assistant/charter over a real instance on a scratch port, including
//                      the 413 and the 409. The live panel on 7331 is never touched.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const { Assistant, parseActions } = await import("../lib/assistant.js");
const { CHARTER_MAX_CHARS, CHARTER_HEADING, appendEntry, pruneCharter, seedCharter } = await import("../lib/charter.js");

const dir = mkdtempSync(path.join(tmpdir(), "charter-test-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
let checks = 0;
const ok = (cond, what, extra = "") => {
  checks += 1;
  if (cond) console.log(`  ok   ${what}`);
  else {
    failures += 1;
    console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ""}`);
  }
};
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), what, `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

// A store with rules and notes in it, the way a panel that has been running for a week has one. Each section
// gets its own directory, so one section's charter is never another's.
const make = (over = {}, slug = "a") => {
  const home = path.join(dir, slug);
  mkdirSync(home, { recursive: true });
  const file = path.join(home, "assistant.json");
  writeFileSync(file, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [], ...over }, null, 1));
  const assistant = new Assistant({
    config: { jobsFile: path.join(home, "jobs.json"), assistantFile: file },
    jobs: { list: () => [], firstOfThread: () => null },
  });
  return { assistant, home, file, charter: path.join(home, "assistant-charter.md") };
};

const LONG_RULE =
  "To tell whether a branch's work is already in main, never compare commit SHAs or trust \"ahead by N\": the ruleset requires linear history, so PRs land as squash or rebase merges and the SHAs are always rewritten. " +
  "Check the merged PR list for the branch and diff the content against main instead, because the ancestry git reports is about the commits it can see, not about the change that landed. THE TAIL ONLY EXISTS IN THE CHARTER.";
const NOTES = "- the harvester dev server is James's, via the rolling issue\n- the local Docker stack is ours\n- port 7331 once had two listeners sharing the job store";

console.log("the seed carries the scratchpad over");
{
  const { charter } = make({ rules: [{ id: "r1", text: LONG_RULE, at: new Date().toISOString(), by: "reader" }], notes: NOTES }, "seeded");
  ok(existsSync(charter), "a charter file is written on first boot", charter);
  const text = readFileSync(charter, "utf8");
  for (const heading of [
    "## Role and remit",
    "## Hard guardrails",
    "## Git facts of this repo",
    "## Ownership splits",
    "## Where things live",
    "## Design questions still unanswered",
    "## How to update this file",
  ]) {
    ok(text.includes(heading), `the seed has ${heading}`);
  }
  ok(text.includes("THE TAIL ONLY EXISTS IN THE CHARTER"), "a long rule is carried in FULL (the preamble clips each one to 200 chars)");
  ok(text.includes("the harvester dev server is James's"), "the scratchpad's notes are carried over");
  ok(text.includes(CHARTER_HEADING), "it has a changelog section");
  ok(/^- \d{4}-\d{2}-\d{2} · charter seeded/m.test(text.split(CHARTER_HEADING)[1].trim()), "the seed leaves a dated entry of its own");
  ok(text.length <= CHARTER_MAX_CHARS, `the seed fits the cap (${text.length}/${CHARTER_MAX_CHARS})`);
  ok(/never claim a command ran/i.test(text) && /never bounce the live panel/i.test(text) && /one worktree holds one live agent/i.test(text), "the hard guardrails are written down");
  ok(/linear history/i.test(text) && /git branch -D/i.test(text) && /the PR is the only authority/i.test(text), "the git facts are written down");
  ok(/harvester/i.test(text) && /Millerfly91/.test(text), "the ownership split is written down");
  ok(/\.agentboard\/settlers-reports/.test(text) && /assistant-charter\.md/.test(text), "where things live is written down");
  ok(/Hermes does NOT read this file/.test(text) && /run_cwd/.test(text), "the file says plainly how it does (and does not) reach a turn");
}

console.log("the cap bounds the seed, oldest first");
{
  const rules = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, text: `rule ${i} ${"x".repeat(400)}`, at: new Date().toISOString(), by: "reader" }));
  const notes = Array.from({ length: 200 }, (_, i) => `- note line ${i} ${"y".repeat(80)}`).join("\n");
  const text = seedCharter({ rules, notes, at: new Date("2026-10-25T00:00:00Z") });
  ok(text.length <= CHARTER_MAX_CHARS, `an oversized store still seeds inside the cap (${text.length}/${CHARTER_MAX_CHARS})`);
  ok(text.includes("rule 39"), "the newest rule survives");
  ok(text.includes("note line 199"), "the newest note line survives");
  ok(text.includes("## Role and remit"), "and the conventions are not what gets dropped");
  const LF = String.fromCharCode(10);
  const over = appendEntry(["z".repeat(CHARTER_MAX_CHARS - 140), CHARTER_HEADING, `- ${"o".repeat(200)}`, ""].join(LF), "a newer entry");
  ok(over.includes("a newer entry"), "an entry still lands when the file is near the cap");
  ok(!over.includes("oooo"), "and pruning drops the OLDEST changelog entry, not the new one");
  ok(over.length <= CHARTER_MAX_CHARS, `and the result is inside the cap (${over.length})`);
}

console.log("the briefing carries the whole file, the polled state does not");
{
  const { assistant } = make({ rules: [{ id: "r1", text: "a standing rule", at: new Date().toISOString(), by: "reader" }], notes: NOTES }, "briefing");
  const briefing = assistant.preamble();
  ok(briefing.includes("## Hard guardrails"), "the charter is in the run's input");
  ok(briefing.includes("## Role and remit"), "in full, not clipped, when it is inside the cap");
  ok(/Charter — the long tier/.test(briefing), "and it is labelled as the long tier");
  ok(/CHARTER: </.test(briefing), "the CHARTER: line is offered as an action");
  const st = assistant.state();
  ok(Boolean(st.charter) && typeof st.charter.path === "string", "the polled state names the path");
  eq(st.charter.cap, CHARTER_MAX_CHARS, "and the cap");
  ok(Number.isFinite(st.charter.mtime), "and when it was last written");
  ok(!("text" in st.charter), "but NOT the text — that is what GET /api/assistant/charter is for");
  ok(!JSON.stringify(st).includes("## Hard guardrails"), "so a board event does not re-send 20 KB");
}

console.log("the readers write it: save, CHARTER: line, rule change");
{
  const { assistant, charter } = make({ notes: NOTES }, "writers");
  const written = "# hand written\n\n- 2026-01-01 · a fresh start\n";
  const before = statSync(charter).mtimeMs;
  const saved = assistant.setCharter(written);
  eq(readFileSync(charter, "utf8"), written, "a save replaces the file whole");
  eq(saved.chars, written.length, "and reports its size");
  ok(statSync(charter).mtimeMs >= before, "the mtime moves");
  ok(assistant.state().journal.some((j) => j.kind === "charter" && /saved by reader/.test(j.text)), "the journal says who saved it");

  // The assistant's own line, through the harvest the panel runs on a finished turn.
  await assistant.harvest({
    id: "job-1",
    thread: "panel-assistant",
    status: "done",
    lines: [{ kind: "text", text: "Written it down.\n\nCHARTER: the runs-api cwd patch is unapplied, so a run's cwd is ignored", at: Date.now() }],
  });
  const after = readFileSync(charter, "utf8");
  ok(/^- \d{4}-\d{2}-\d{2} · entry: the runs-api cwd patch is unapplied/m.test(after.split(CHARTER_HEADING)[1].trim()), "a CHARTER: line lands in the file, dated");
  ok(assistant.state().journal.some((j) => j.kind === "charter" && /charter entry/.test(j.text)), "and is written to the journal");

  // A standing rule changing is the other trigger the file's own instructions name.
  assistant.addRule("deploy to QA, never PROD");
  ok(/added a standing rule: deploy to QA, never PROD/.test(readFileSync(charter, "utf8")), "a new standing rule appends a dated entry");

  const forms = parseActions("CHARTER: one\nCHARTER - two\nCHARTER three\nCHARTERS are not this");
  eq(forms.charter.length, 3, "colon, dash and bare CHARTER forms all parse", JSON.stringify(forms.charter));
  eq(parseActions("CHARTERS are not this").charter.length, 0, "CHARTERS is not CHARTER");
}

console.log("the refusals: over the cap, and a save that read an older file");
{
  const { assistant, charter } = make({ notes: NOTES }, "refusals");
  assistant.setCharter("small enough\n");
  const mtime = assistant.charterPayload().mtime;
  let code = null;
  try {
    assistant.setCharter("x".repeat(CHARTER_MAX_CHARS + 1));
  } catch (err) {
    code = err.code;
  }
  eq(code, "charter-too-long", "a body over the cap is refused with its own code");
  eq(readFileSync(charter, "utf8"), "small enough\n", "and the file is untouched");

  // The assistant writes while the reader's box is open: the reader's save must not silently win.
  await sleep(30);
  assistant.appendCharter("something happened in between");
  code = null;
  try {
    assistant.setCharter("the reader's version", "reader", { expectMtime: mtime });
  } catch (err) {
    code = err.code;
  }
  eq(code, "charter-stale", "a save loaded before another writer moved the file is refused");
  ok(readFileSync(charter, "utf8").includes("something happened in between"), "and the newer text is still there");
  eq(assistant.setCharter("the reader's version", "reader", { expectMtime: assistant.charterPayload().mtime }).text, "the reader's version", "a save that read the current file goes through");

  // A hand-edited file over the cap: the briefing clips it and says so rather than swallowing it.
  writeFileSync(charter, `# hand written\n${"y".repeat(CHARTER_MAX_CHARS + 500)}\n`);
  const brief = assistant.preamble();
  ok(/clipped here at \d+ of \d+ chars/.test(brief), "an over-cap file is clipped in the briefing");
  ok(brief.includes("[clipped:"), "and named as clipped");
  ok(assistant.state().charter.over === true, "and the state flags it as over the cap");
  eq(pruneCharter("# only prose\n", 5), "# only prose\n", "a file with no changelog is left alone by the pruner");
}

console.log("GET and PUT /api/assistant/charter, over a real instance on a scratch port");
{
  const sandbox = mkdtempSync(path.join(tmpdir(), "charter-panel-"));
  const emptyRepo = path.join(sandbox, "empty");
  mkdirSync(emptyRepo, { recursive: true });
  const freePort = await new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const cfgPath = path.join(sandbox, "panel-config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify(
      {
        port: freePort,
        host: "127.0.0.1",
        scanRoots: [emptyRepo],
        projects: [],
        defaultCwd: sandbox,
        jobsFile: path.join(sandbox, "logs", "jobs.json"),
        assistantFile: path.join(sandbox, "logs", "assistant.json"),
        // The sentry stays quiet: this proves the route, not the clock. GET and PUT do not consult `enabled`.
        assistant: { enabled: false },
      },
      null,
      2,
    ),
  );
  ok(existsSync(cfgPath) && statSync(cfgPath).size > 0, "the sandbox config is on disk and not empty (a PANEL_CONFIG that does not resolve IS the live port)");
  // A throwaway HERMES_HOME, so a scratch instance cannot read the real .env or post a real run.
  const hermesHome = path.join(sandbox, "hermes-home");
  mkdirSync(hermesHome, { recursive: true });
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: cfgPath, HERMES_HOME: hermesHome, PANEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += String(d)));
  child.stderr.on("data", (d) => (out += String(d)));
  const base = `http://127.0.0.1:${freePort}`;
  const up = async () => {
    for (let i = 0; i < 200; i += 1) {
      try {
        const r = await fetch(`${base}/api/health`);
        if (r.ok) return true;
      } catch {
        /* not listening yet */
      }
      await sleep(100);
    }
    return false;
  };
  try {
    const listening = await up();
    ok(listening, `the scratch instance answers on ${base} — the bind is its own port, not 7331`, out.slice(-500));
    if (listening) {
      const charterFile = path.join(sandbox, "logs", "assistant-charter.md");
      ok(existsSync(charterFile), "the instance seeded its own charter beside its own job store", charterFile);

      const g = await fetch(`${base}/api/assistant/charter`);
      const gd = await g.json();
      eq(g.status, 200, "GET answers 200");
      ok(gd.charter && typeof gd.charter.text === "string" && gd.charter.text.includes("## Role and remit"), "GET carries the text");
      eq(gd.charter.cap, CHARTER_MAX_CHARS, "and the cap");
      ok(gd.assistant && !("text" in gd.assistant.charter), "while the state it rides with still does not");

      await sleep(30);
      const p = await fetch(`${base}/api/assistant/charter`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "# written by the route\n", expectMtime: gd.charter.mtime }),
      });
      const pd = await p.json();
      eq(p.status, 200, "PUT answers 200");
      eq(readFileSync(charterFile, "utf8"), "# written by the route\n", "and the file on disk is what the route was given");
      ok(pd.charter.mtime > gd.charter.mtime, "with a fresh mtime back");

      const stale = await fetch(`${base}/api/assistant/charter`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "# stale\n", expectMtime: gd.charter.mtime }),
      });
      eq(stale.status, 409, "a stale save is a 409");
      const big = await fetch(`${base}/api/assistant/charter`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "x".repeat(CHARTER_MAX_CHARS + 10) }),
      });
      const bigd = await big.json();
      eq(big.status, 413, "an over-cap save is a 413");
      ok(/cap is \d+/.test(bigd.error || ""), "with the numbers in the message", bigd.error);
      eq(readFileSync(charterFile, "utf8"), "# written by the route\n", "and neither refusal wrote anything");

      const g2 = await fetch(`${base}/api/assistant/charter`);
      eq((await g2.json()).charter.text, "# written by the route\n", "the route reads back what it wrote");
    }
  } finally {
    child.kill();
    await sleep(400);
    rmSync(sandbox, { recursive: true, force: true });
  }
}

rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nall ${checks} charter checks passed`);
process.exitCode = failures ? 1 : 0;
