// An attached file on a reader's message must reach the worker the assistant SPAWNs.
//
//   node tools/verify-attachment-spawn.mjs                        # this checkout
//   node tools/verify-attachment-spawn.mjs --root <export dir>     # a `git archive` of another commit
//
// This is the gate, not the unit test: it boots the REAL panel (server.js) on a free port with a throwaway
// config and a TEMP attachmentsDir, points it at a stub gateway, and then does exactly what the page does —
//
//   POST /api/attachments          the reader drops two files; the panel stores them and answers with paths
//   POST /api/assistant/say        the reader's message, with the page's own `Attachment:` block appended
//   (stub gateway)                 the assistant answers with a SPAWN line — and produces a second run in
//                                  its reply, which is the worker the panel started
//
// — and then reads what the WORKER was handed: the run's input (given to the gateway) and its card in
// /api/jobs. Three scenarios, because the boundary has three sides: a turn carrying two files, a turn
// carrying one file the panel never stored, and a turn carrying nothing at all.
//
// The failing-first proof is the `--root` flag: run it against `git archive main` and the checks that depend
// on the inheritance fail while the rest of the harness passes, because main's harvest hands a worker its
// brief and nothing else. Run it here and every check passes.
//
// Counted: the last line is `RESULT: ALL PASS (<n> checks)` or `RESULT: <k>/<n> FAILED`, and the exit code
// is 1 on any failure.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { git, startPanel, waitFor } from "./panel-testkit.mjs";

let failed = 0;
let checks = 0;
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (!cond) failed += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  return Boolean(cond);
};

// `--root <dir>`: the checkout to boot. Absent, the one beside this tool.
const argAt = process.argv.indexOf("--root");
const ROOT = argAt > 0 && process.argv[argAt + 1] ? path.resolve(process.argv[argAt + 1]) : null;

const slash = (p) => String(p || "").replace(/\\/g, "/");
// The page's own size formatter (public/core/dom-format.js `fmtBytes`), written out here on purpose: this tool
// must not import the module it is proving, or main's export — which has no such module — could not run it.
const fmtBytes = (n) => {
  const bytes = Number(n) || 0;
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
};
// The page's own line (public/board/attachments.js `attachmentBlock`), byte for byte, including the em dash.
const line = (a) => `Attachment: ${slash(a.path)} (${a.type || "unknown type"}, ${fmtBytes(a.bytes)}) — ${/^image\//.test(String(a.type || "")) ? "use vision_analyze on it" : "read_file it"} before answering.`;

const dir = mkdtempSync(path.join(tmpdir(), "wtgui-attach-gate-"));
const attachmentsDir = slash(path.join(dir, "attachments"));
mkdirSync(attachmentsDir, { recursive: true });
// The tree a SPAWN IN names: a real repository, because the panel refuses one that is not.
const tree = slash(path.join(dir, "tree"));
mkdirSync(tree, { recursive: true });
git(tree, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(tree, "README.md"), "seed\n");
git(tree, ["add", "-A"]);
git(tree, ["commit", "-q", "-m", "seed"]);

// ---- the stub gateway ---------------------------------------------------------------------------------
// One reply per assistant turn, chosen by the marker the tool puts in its message; every other session (the
// workers the panel starts) gets a short acknowledgement and ends.
const runs = new Map(); // run id -> { thread, input }
const inputs = new Map(); // thread -> the input its last run was sent
const replies = new Map(); // marker -> the assistant's reply
let seq = 0;
const gateway = createServer((req, res) => {
  const url = String(req.url || "");
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") : {};
    if (req.method === "GET" && url === "/v1/capabilities") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ version: "gate", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true } }),
      );
      return;
    }
    if (req.method === "POST" && url === "/v1/runs") {
      const id = `run_${++seq}`;
      const thread = String(body.session_id || "");
      const input = String(body.input || "");
      runs.set(id, { thread, input });
      inputs.set(thread, input);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ run_id: id, session_id: thread }));
      return;
    }
    if (req.method === "GET" && /^\/v1\/runs\/[^/]+\/events$/.test(url)) {
      const id = url.split("/")[3];
      const run = runs.get(id) || { thread: "", input: "" };
      let paragraphs = ["Acknowledged."];
      if (run.thread === "panel-assistant") {
        const marker = [...replies.keys()].find((m) => run.input.includes(m));
        paragraphs = marker ? replies.get(marker) : ["Nothing to do."];
      }
      const frames = paragraphs.map((p, i) => ({ event: "message.delta", delta: i === 0 ? p : `\n\n${p}` }));
      frames.push({ event: "run.completed", output: paragraphs.join("\n\n"), usage: { total_tokens: 40, input_tokens: 30, output_tokens: 10 } });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      let i = 0;
      const timer = setInterval(() => {
        if (i >= frames.length) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify(frames[i++])}\n\n`);
      }, 3);
      timer.unref?.();
      return;
    }
    if (req.method === "GET" && /^\/v1\/runs\/[^/]+$/.test(url)) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "completed", output: "" }));
      return;
    }
    if (req.method === "POST" && /\/v1\/runs\/[^/]+\/(steer|stop|approval|clarify)$/.test(url)) {
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "no such route", code: "not_found" } }));
  });
});
await new Promise((open) => gateway.listen(0, "127.0.0.1", open));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;

let panel = null;
try {
  panel = await startPanel({
    ...(ROOT ? { root: ROOT } : {}),
    config: {
      attachmentsDir,
      apiServer: { url: gatewayUrl, key: "gate" },
      projects: [],
    },
  });
  const base = panel.base;
  const post = async (route, body) => {
    const r = await fetch(`${base}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // The SPAWN switch is the only gate on a SPAWN line; the harvest must be allowed to start one.
  const settings = await post("/api/assistant/settings", { spawn: "auto", autonomy: "auto" });
  ok("the panel's assistant can start a worker on its own", settings.status === 200 && settings.body?.settings?.spawn === "auto", `spawn=${settings.body?.settings?.spawn}`);

  // ---- uploads, through the route the page uses ------------------------------------------------------
  const upload = async (name, type, bytes) => {
    const r = await fetch(`${base}/api/attachments`, { method: "POST", headers: { "Content-Type": type, "x-filename": encodeURIComponent(name) }, body: Buffer.alloc(bytes, 0x41) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const shot = await upload("screenshot.png", "image/png", 40 * 1024);
  const brief = await upload("brief.txt", "text/plain", 1500);
  ok("the panel stored the image under its attachments directory", shot.status === 201 && slash(shot.body?.path).startsWith(`${attachmentsDir}/`), shot.body?.path);
  ok("…and the document", brief.status === 201 && slash(brief.body?.path).startsWith(`${attachmentsDir}/`), brief.body?.path);

  // The worker's card, once the store holds it: the record's attachment list is written a moment after the
  // run is posted, so "the run arrived" is not yet "the card has it".
  const childOf = async (thread, ms = 15_000) => {
    const until = Date.now() + ms;
    for (;;) {
      const d = await fetch(`${base}/api/jobs`).then((r) => r.json()).catch(() => null);
      const job = (d?.jobs || []).find((j) => j.thread === thread);
      if (job) return job;
      if (Date.now() > until) return null;
      await new Promise((res) => setTimeout(res, 120));
    }
  };
  const childThreads = async () => [...inputs.keys()].filter((t) => t !== "panel-assistant");

  // ---- 1. a turn carrying two files -----------------------------------------------------------------
  console.log("a reader attaches two files and asks for a worker");
  replies.set("GATE-ONE", [`SPAWN IN ${tree} | read both files and write the summary`, "NOTE: handed the two files on."]);
  const said = await post("/api/assistant/say", { text: `GATE-ONE have a look at these and start a worker on it.\n\n${line(shot.body)}\n\n${line(brief.body)}` });
  ok("the assistant's turn was accepted", said.status === 202, `HTTP ${said.status}`);

  const firstChild = await waitFor(async () => (await childThreads())[0], { timeoutMs: 30_000, what: "the worker the SPAWN line starts" });
  ok("the SPAWN line started a worker", Boolean(firstChild), firstChild || "no second run reached the gateway");
  let childInput = firstChild ? inputs.get(firstChild) || "" : "";
  // …and its card, once the store has it (the record is written just after the run is posted).
  const firstJob = firstChild ? await childOf(firstChild).catch(() => null) : null;

  ok(
    "the worker's input names the image for vision_analyze",
    childInput.includes(`Attachment: ${slash(shot.body?.path)} (image/png, 40 KB) — use vision_analyze on it before answering.`),
    firstChild ? "" : "no worker",
  );
  ok(
    "the worker's input names the document for read_file",
    childInput.includes(`Attachment: ${slash(brief.body?.path)} (text/plain, 1 KB) — read_file it before answering.`),
    firstChild ? "" : "no worker",
  );
  const recorded = (firstJob?.attachments || []).map((a) => slash(a.path)).sort();
  ok(
    "the worker's own record carries both files",
    recorded.length === 2 && recorded.includes(slash(shot.body?.path)) && recorded.includes(slash(brief.body?.path)),
    JSON.stringify(recorded),
  );
  ok("the worker's card still shows the brief, not the path block", firstJob?.prompt === "read both files and write the summary", JSON.stringify(firstJob?.prompt));

  // ---- 2. a turn carrying a file the panel never stored -----------------------------------------------
  console.log("a path outside the panel's attachments directory is not inherited");
  const outside = slash(path.join(dir, "private", "secret.txt"));
  mkdirSync(path.dirname(outside), { recursive: true });
  writeFileSync(outside, "not the panel's to hand on\n");
  const before = (await childThreads()).length;
  replies.set("GATE-TWO", [`SPAWN IN ${tree} | use the file the reader attached`, "NOTE: one file was outside the store."]);
  await post("/api/assistant/say", { text: `GATE-TWO use these.\n\n${line(shot.body)}\n\n${line({ path: outside, type: "text/plain", bytes: 900 })}` });
  const secondChild = await waitFor(async () => ((await childThreads()).length > before ? (await childThreads()).at(-1) : null), { timeoutMs: 30_000, what: "the second worker" });
  const secondInput = secondChild ? inputs.get(secondChild) || "" : "";
  const secondJob = secondChild ? await childOf(secondChild).catch(() => null) : null;
  ok(
    "the outside path is not in the worker's record",
    Boolean(secondChild) && (secondJob?.attachments || []).every((a) => slash(a.path) !== outside),
    JSON.stringify((secondJob?.attachments || []).map((a) => a.path)),
  );
  ok(
    "the worker's input says the file was dropped, and why",
    secondInput.includes(`Attachment dropped: ${outside} — it is outside the panel's attachments directory (${attachmentsDir}), so it was not inherited.`),
    secondChild ? "" : "no worker",
  );
  ok("…and no attachment line hands it on", !secondInput.includes(`Attachment: ${outside}`));

  // ---- 3. a turn carrying nothing -------------------------------------------------------------------
  console.log("a turn with no attachment hands the worker its brief alone");
  const beforeThree = (await childThreads()).length;
  replies.set("GATE-THREE", [`SPAWN IN ${tree} | tidy the leftover files and say what you found`]);
  await post("/api/assistant/say", { text: "GATE-THREE start a worker on the leftovers." });
  const thirdChild = await waitFor(async () => ((await childThreads()).length > beforeThree ? (await childThreads()).at(-1) : null), { timeoutMs: 30_000, what: "the third worker" });
  const thirdInput = thirdChild ? inputs.get(thirdChild) || "" : "";
  const thirdJob = thirdChild ? await childOf(thirdChild).catch(() => null) : null;
  ok("the worker started", Boolean(thirdChild));
  ok("its input carries no attachment line", Boolean(thirdChild) && !/Attachment:/.test(thirdInput));
  ok("…and says nothing about a drop that never happened", Boolean(thirdChild) && !/Attachment dropped:/.test(thirdInput));
  ok("…and its record carries no attachment", Boolean(thirdChild) && (thirdJob?.attachments || []).length === 0, JSON.stringify(thirdJob?.attachments));
} catch (e) {
  failed += 1;
  checks += 1;
  console.log(`FAIL  the gate could not finish — ${String((e && e.stack) || e)}`);
} finally {
  try {
    await panel?.stop();
  } catch {
    /* the sandbox is the OS's problem */
  }
  gateway.close();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* a temp dir a live child still holds */
  }
}

console.log(failed ? `RESULT: ${failed}/${checks} FAILED` : `RESULT: ALL PASS (${checks} checks)`);
process.exit(failed ? 1 : 0);
