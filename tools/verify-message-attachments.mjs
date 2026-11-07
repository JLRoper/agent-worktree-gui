// HARNESS: LIVE GATE — a MESSAGE line carries the sender turn's files, and only the panel's own files.
//
// WHY THIS IS A GATE AND NOT FROZEN EVIDENCE. The defect it was written for (a Director's MESSAGE sent the
// sentence and dropped the image the reader had pasted on that turn) is history, but the RULE is live behaviour
// main has to keep, and it is the same rule a SPAWN holds: an assistant handing a file to another assistant may
// hand on only a path the panel stored, the receiving turn must show it, and a refused path must be NAMED.
//
//   npm run verify:message-attachments                 the repo's own name for this gate
//   node tools/verify.mjs --only message-attachments   the same thing through the runner
//
// This is the gate, not the unit test: it boots the REAL panel (server.js) on a free port with a throwaway config
// and a TEMP attachmentsDir, points it at a stub gateway, and then does exactly what the page does —
//
//   POST /api/assistant/assistants   a Director is created from its role (thread panel-assistant-2)
//   POST /api/attachments            the reader PASTES A PNG; the panel stores it and answers with its path
//   POST /api/assistant/say          the reader's turn on the DIRECTOR, with the page's own `Attachment:` block
//   (stub gateway)                   the Director answers with `MESSAGE assistant-1 | …`
//   (stub gateway)                   the receiving assistant answers with `SPAWN IN <tree> | …`
//
// — and then reads what the RECEIVING turn and its WORKER were handed: the run's input (given to the gateway) and
// the turn's card in /api/jobs. Three scenarios, because the boundary has three sides: an image on the sender's
// turn, a path the panel never stored, and a turn carrying nothing at all.
//
// The failing-first proof is `--root`: run it against `git archive main` and the checks that depend on the
// inheritance fail (main's `say()` takes no attachments and its MESSAGE handler passes none) while the rest of the
// harness passes. Run it here and every check passes.
//
// Counted: the last line is `RESULT: ALL PASS (<n> checks)` or `RESULT: <k>/<n> FAILED`, and the exit code is 1
// on any failure.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createVerifier, git, slash, startPanel, waitFor } from "./panel-testkit.mjs";

const { ok, totals } = (() => {
  const v = createVerifier();
  return {
    ok: v.ok,
    totals: () => ({ checks: v.checks, failures: v.failures }),
  };
})();

// `--root <dir>`: the checkout to boot. Absent, the one beside this tool.
const argAt = process.argv.indexOf("--root");
const ROOT = argAt > 0 && process.argv[argAt + 1] ? path.resolve(process.argv[argAt + 1]) : null;

const DIRECTOR_THREAD = "panel-assistant-2";
const PRIMARY_THREAD = "panel-assistant";

// The page's own size formatter (public/core/dom-format.js `fmtBytes`), written out here on purpose: this tool
// must not import the module it is proving, or main's export — which has no such module — could not run it.
const fmtBytes = (n) => {
  const bytes = Number(n) || 0;
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
};
// The page's own line (public/board/attachments.js `attachmentBlock`), byte for byte, including the em dash.
const line = (a) => `Attachment: ${slash(a.path)} (${a.type || "unknown type"}, ${fmtBytes(a.bytes)}) — ${/^image\//.test(String(a.type || "")) ? "use vision_analyze on it" : "read_file it"} before answering.`;

// A real 1x1 PNG: "paste an image" should be a bytes-for-bytes image, not a file the panel was told is one.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const dir = mkdtempSync(path.join(tmpdir(), "wtgui-message-gate-"));
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
// One reply per SESSION, chosen by the thread the run was posted to; every other session gets a short
// acknowledgement and ends.
const runs = new Map(); // run id -> { thread, input }
const inputs = new Map(); // thread -> the input its last run was sent
const replies = new Map(); // thread -> the paragraphs that session's assistant answers with
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
      const paragraphs = replies.get(run.thread) || ["Acknowledged."];
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
  const jobsNow = () => fetch(`${base}/api/jobs`).then((r) => r.json()).catch(() => null);

  // ---- the sender: a Director, from its own role ------------------------------------------------------
  const made = await post("/api/assistant/assistants", { roleId: "assistant-director" });
  const director = made.body?.created?.id || "";
  ok("a Director was created from its role", made.status === 201 && director === "assistant-2", `HTTP ${made.status} ${director || JSON.stringify(made.body?.error || "")}`);
  ok("…on its own thread", made.body?.created?.threadId === DIRECTOR_THREAD, made.body?.created?.threadId);

  // The receiving assistant is the one that starts a worker on what it was handed.
  replies.set(PRIMARY_THREAD, [`SPAWN IN ${tree} | read the screenshot and write the summary`]);
  // The SPAWN switch is the only gate on a SPAWN line; the harvest must be allowed to start one.
  const settings = await post("/api/assistant/settings", { spawn: "auto", autonomy: "auto" });
  ok("the panel's assistant can start a worker on its own", settings.status === 200 && settings.body?.settings?.spawn === "auto", `spawn=${settings.body?.settings?.spawn}`);

  // ---- paste an image, through the route the page uses -------------------------------------------------
  const upload = async (name, type, bytes) => {
    const r = await fetch(`${base}/api/attachments`, { method: "POST", headers: { "Content-Type": type, "x-filename": encodeURIComponent(name) }, body: bytes });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const shot = await upload("pasted.png", "image/png", PNG_1X1);
  ok("the panel stored the pasted image under its attachments directory", shot.status === 201 && slash(shot.body?.path).startsWith(`${attachmentsDir}/`), shot.body?.path);
  ok("…as an image it can be told to look at", shot.body?.type === "image/png", shot.body?.type);

  // The receiving turn's card, once the store holds it. `not` is the set of ids the store already had before this
  // message was sent: the previous message's turn is settled and still listed, and "a turn exists" is not "THIS
  // message's turn exists".
  const messageTurn = async (not = new Set(), ms = 30_000) => {
    const until = Date.now() + ms;
    for (;;) {
      const d = await jobsNow();
      const job = (d?.jobs || []).find((j) => j.origin?.kind === "assistant-message" && !not.has(j.id));
      if (job && job.status !== "starting" && job.status !== "running") return job;
      if (Date.now() > until) return null;
      await new Promise((res) => setTimeout(res, 150));
    }
  };
  const idsNow = async () => new Set(((await jobsNow())?.jobs || []).map((j) => j.id));
  const workerOf = async (thread, ms = 15_000) => {
    const until = Date.now() + ms;
    for (;;) {
      const d = await jobsNow();
      const job = (d?.jobs || []).find((j) => j.thread === thread);
      if (job) return job;
      if (Date.now() > until) return null;
      await new Promise((res) => setTimeout(res, 120));
    }
  };
  const workerThreads = () => [...inputs.keys()].filter((t) => t !== PRIMARY_THREAD && t !== DIRECTOR_THREAD);

  // ---- 1. an image pasted on the Director's turn, messaged to the assistant -----------------------------
  console.log("the reader pastes an image, and the Director messages #1 about it");
  const beforeOne = await idsNow();
  replies.set(DIRECTOR_THREAD, [`MESSAGE assistant-1 | the reader's screenshot is on your turn — start a worker to read it.`]);
  const said = await post("/api/assistant/say", {
    text: `GATE-MSG-ONE have a look at this and hand it to #1.\n\n${line(shot.body)}`,
    assistantId: director,
  });
  ok("the Director's turn was accepted", said.status === 202, `HTTP ${said.status}`);

  const received = await messageTurn(beforeOne);
  ok("the MESSAGE line started a turn on the receiving assistant's thread", Boolean(received), received ? received.thread : "no assistant-message turn appeared");
  ok("…on Assistant #1's thread", received?.thread === PRIMARY_THREAD, received?.thread);
  const recorded = (received?.attachments || []).map((a) => slash(a.path));
  ok("the receiving turn's card carries the pasted image", recorded.includes(slash(shot.body?.path)), JSON.stringify(recorded));
  ok("…and shows the message, not the path block", Boolean(received?.prompt) && /^message from /.test(received.prompt) && !/Attachment:/.test(received.prompt), JSON.stringify(received?.prompt));
  const receivingInput = inputs.get(PRIMARY_THREAD) || "";
  ok(
    "the receiving turn's input names the image for vision_analyze",
    receivingInput.includes(`Attachment: ${slash(shot.body?.path)} (image/png, ${fmtBytes(shot.body?.bytes)}) — use vision_analyze on it before answering.`),
    "",
  );

  const worker = await waitFor(async () => workerThreads()[0], { timeoutMs: 40_000, what: "the worker the receiving turn starts" });
  ok("the receiving turn's SPAWN line started a worker", Boolean(worker), worker || "no worker run reached the gateway");
  const workerInput = worker ? inputs.get(worker) || "" : "";
  const workerJob = worker ? await workerOf(worker).catch(() => null) : null;
  ok(
    "the worker's input names the image too",
    workerInput.includes(`Attachment: ${slash(shot.body?.path)} (image/png, ${fmtBytes(shot.body?.bytes)}) — use vision_analyze on it before answering.`),
    worker ? "" : "no worker",
  );
  ok(
    "…and its own record carries it",
    (workerJob?.attachments || []).some((a) => slash(a.path) === slash(shot.body?.path)),
    JSON.stringify((workerJob?.attachments || []).map((a) => a.path)),
  );

  // ---- 2. a path the panel never stored -----------------------------------------------------------------
  console.log("a path outside the panel's attachments directory is refused, and named");
  const outside = slash(path.join(dir, "private", "secret.txt"));
  mkdirSync(path.dirname(outside), { recursive: true });
  writeFileSync(outside, "not the panel's to hand on\n");
  const beforeTwo = workerThreads().length;
  const idsTwo = await idsNow();
  replies.set(PRIMARY_THREAD, [`SPAWN IN ${tree} | use the file the reader attached`]);
  replies.set(DIRECTOR_THREAD, [`MESSAGE assistant-1 | both files are on your turn: use the stored one.`]);
  await post("/api/assistant/say", {
    text: `GATE-MSG-TWO use these.\n\n${line(shot.body)}\n\n${line({ path: outside, type: "text/plain", bytes: 900 })}`,
    assistantId: director,
  });
  const second = await messageTurn(idsTwo);
  const secondInput = second ? (inputs.get(PRIMARY_THREAD) || "") : "";
  ok("the second message arrived", Boolean(second), second ? second.id : "no assistant-message turn appeared");
  ok(
    "the outside path is not on the receiving turn's card",
    Boolean(second) && (second.attachments || []).every((a) => slash(a.path) !== outside),
    JSON.stringify((second?.attachments || []).map((a) => a.path)),
  );
  ok(
    "the receiving turn's input says the file was dropped, and why",
    secondInput.includes(`Attachment dropped: ${outside} — it is outside the panel's attachments directory (${attachmentsDir}), so it was not inherited.`),
    second ? "" : "no turn",
  );
  ok("…and no attachment line hands it on", Boolean(second) && !secondInput.includes(`Attachment: ${outside}`));
  // The refusal reaches the worker that turn starts, too — as an ABSENCE: the receiving turn's card kept only
  // what the panel stored, so the worker inherits the stored image and there is nothing left to refuse. (A
  // refusal is said once, where the claim was made: on the receiving turn.)
  const secondWorker = await waitFor(async () => (workerThreads().length > beforeTwo ? workerThreads().at(-1) : null), { timeoutMs: 40_000, what: "the second worker" });
  const secondWorkerInput = secondWorker ? inputs.get(secondWorker) || "" : "";
  ok(
    "the worker's input names only the stored file",
    Boolean(secondWorker) && secondWorkerInput.includes(`Attachment: ${slash(shot.body?.path)}`) && !secondWorkerInput.includes(`Attachment: ${outside}`),
    secondWorker ? "" : "no second worker",
  );

  // ---- 3. a turn carrying nothing -----------------------------------------------------------------------
  console.log("a MESSAGE with no files hands the receiving turn its words alone");
  const beforeThree = workerThreads().length;
  const idsThree = await idsNow();
  replies.set(DIRECTOR_THREAD, [`MESSAGE assistant-1 | nothing to hand over, only words.`]);
  await post("/api/assistant/say", { text: "GATE-MSG-THREE just a note for #1.", assistantId: director });
  const third = await messageTurn(idsThree);
  const thirdInput = third ? inputs.get(PRIMARY_THREAD) || "" : "";
  ok("the third message arrived", Boolean(third), third ? third.id : "no assistant-message turn appeared");
  ok("its card carries no attachment", Boolean(third) && (third.attachments || []).length === 0, JSON.stringify(third?.attachments));
  ok("its input carries no attachment line", Boolean(third) && !/Attachment:/.test(thirdInput));
  ok("…and says nothing about a drop that never happened", Boolean(third) && !/Attachment dropped:/.test(thirdInput));
  ok("…and it still started the worker its reply asked for", (await waitFor(async () => (workerThreads().length > beforeThree ? workerThreads().at(-1) : null), { timeoutMs: 40_000, what: "the third worker" })) !== null);
} catch (e) {
  ok(`the gate could not finish — ${String((e && e.stack) || e)}`, false);
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

const total = totals();
console.log(total.failures ? `RESULT: ${total.failures}/${total.checks} FAILED` : `RESULT: ALL PASS (${total.checks} checks)`);
process.exit(total.failures ? 1 : 0);
