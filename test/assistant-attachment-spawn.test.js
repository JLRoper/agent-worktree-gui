// An attached file on a reader's message must reach the worker the assistant SPAWNs.
//
// The chain this pins, end to end inside one panel:
//
//   the reader drops a file on the reply box -> POST /api/attachments stores it under config.attachmentsDir
//   and answers with its ABSOLUTE PATH -> the page appends `Attachment: <path> — read_file it before
//   answering.` to the reader's message -> the assistant reads that message and writes a SPAWN line ->
//   the child job carries the file on its own record AND names it in its own input.
//
// What it asserts, in the order the brief lists it:
//
//   1. the child record carries the turn's attachments (via `jobs.addAttachments`);
//   2. the child's input names each one, in the page's convention — absolute path plus the one-line
//      instruction (read_file for a document, vision_analyze for an image);
//   3. ONLY paths inside config.attachmentsDir are inherited. An outside path — in the reader's message
//      or written into the SPAWN line itself — is dropped and the drop is SAID in the child's input, on
//      the child's card and in the journal. A SPAWN line must never be able to hand a worker an
//      arbitrary file by writing an `Attachment:` line;
//   4. a turn with no attachments produces the child input it always produced — byte for byte.
//
// It drives the REAL spawner (lib/features/spawn.js `assistantSpawnRun` -> the same `jobs.create` the
// server uses) through a stub gateway, so a field dropped on the way from the harvest to the run's
// request fails here rather than only in the browser gate.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Jobs } from "../lib/jobs.js";
import { Assistant, ASSISTANT_THREAD } from "../lib/assistant.js";
import { attachmentBlock, attachmentLine } from "../lib/attachments.js";
import { createSpawn } from "../lib/features/spawn.js";

const slash = (p) => String(p).replace(/\\/g, "/");
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// ---- a stub gateway ---------------------------------------------------------------------------------
// POST /v1/runs records the run's input against its session; GET .../events streams the reply that was set
// for that session and ends the run. That is everything the panel needs and nothing else.
async function stubGateway() {
  const runs = new Map(); // run id -> { thread, input }
  const inputs = new Map(); // thread -> the input its LAST run was sent
  let reply = ["Acknowledged."];
  let seq = 0;
  const server = createServer((req, res) => {
    const url = String(req.url || "");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") : {};
      // The spawner probes this before it promises anything, so a stub without it refuses every spawn.
      if (req.method === "GET" && url === "/v1/capabilities") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            version: "stub",
            features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true },
          }),
        );
        return;
      }
      if (req.method === "POST" && url === "/v1/runs") {
        const id = `run_${++seq}`;
        const thread = String(body.session_id || "");
        runs.set(id, { thread, input: String(body.input || "") });
        inputs.set(thread, String(body.input || ""));
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ run_id: id, session_id: thread }));
        return;
      }
      if (req.method === "GET" && /^\/v1\/runs\/[^/]+\/events$/.test(url)) {
        const id = url.split("/")[3];
        const run = runs.get(id) || { thread: "" };
        const lines = run.thread === ASSISTANT_THREAD ? reply : ["done"];
        const frames = lines.map((p, i) => ({ event: "message.delta", delta: i === 0 ? p : `\n\n${p}` }));
        frames.push({ event: "run.completed", output: lines.join("\n\n"), usage: { total_tokens: 100, input_tokens: 80, output_tokens: 20 } });
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        let i = 0;
        const timer = setInterval(() => {
          if (i >= frames.length) {
            clearInterval(timer);
            res.end();
            return;
          }
          res.write(`data: ${JSON.stringify(frames[i++])}\n\n`);
        }, 2);
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
  await new Promise((open) => server.listen(0, "127.0.0.1", open));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    runs,
    inputs,
    setReply: (lines) => {
      reply = lines.slice();
    },
    close: () => new Promise((done) => server.close(done)),
  };
}

// ---- the panel: a real store, a real assistant, the real spawner --------------------------------------
async function panel(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-attach-spawn-"));
  const gw = await stubGateway();
  const attachmentsDir = slash(path.join(dir, "attachments"));
  mkdirSync(attachmentsDir, { recursive: true });
  // The tree a SPAWN IN names: a real repository, because the spawner refuses one that is not.
  const tree = slash(path.join(dir, "tree"));
  mkdirSync(tree, { recursive: true });
  const email = ["tester", "example.invalid"].join(String.fromCharCode(64));
  const git = (...args) =>
    execFileSync("git", ["-C", tree, "-c", "user.name=Test", "-c", `user.email=${email}`, "-c", "commit.gpgsign=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(tree, "README.md"), "seed\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");

  const events = [];
  let assistant = null;
  const config = { jobsFile: path.join(dir, "jobs.json"), apiServer: { url: gw.url, key: "stub" }, defaultCwd: dir };
  const jobs = new Jobs({
    config,
    onEvent: (evt) => {
      events.push(evt);
      // The server's own wiring: a finished turn reaches the harvest through this observer, never by a direct call.
      try {
        assistant?.observe(evt);
      } catch {
        /* the harvest reports its own failures */
      }
    },
    onLog: () => {},
  });
  const spawn = createSpawn({ getConfig: () => config, getProjects: () => [], jobs });
  assistant = new Assistant({
    config: { ...config, assistantFile: path.join(dir, "assistant.json"), attachmentsDir },
    jobs,
    getProjects: () => [],
    getRows: () => [],
    getChildren: () => ({}),
    spawner: spawn.assistantSpawnRun,
    onEvent: () => {},
    onLog: () => {},
  });
  assistant.settings.autonomy = "auto";
  assistant.settings.spawn = "auto";

  const waitFor = async (fn, ms = 12_000) => {
    const until = Date.now() + ms;
    for (;;) {
      const got = await fn();
      if (got) return got;
      if (Date.now() > until) return null;
      await tick();
    }
  };
  const settled = (id) =>
    waitFor(() => {
      const j = jobs.jobs.get(id);
      return j && j.status !== "running" && j.status !== "starting" ? j : null;
    });

  // The child's record is written a moment AFTER `create()` returns (addAttachments runs there), and the job
  // appears in the store before `create()` has even posted its run — so "it exists" is not "it is finished".
  const waitChild = () =>
    waitFor(() => {
      const child = [...jobs.jobs.values()].find((j) => j.origin?.kind === "assistant-spawn");
      return child && child.status !== "starting" && child.status !== "running" ? child : null;
    }, 12_000);

  t.after(async () => {
    for (const timer of ["wakeTimer", "settleTimer", "timer"]) if (assistant[timer]) clearTimeout(assistant[timer]);
    await gw.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  return { dir, gw, attachmentsDir, tree, jobs, assistant, events, waitFor, settled, waitChild };
}

// A file the panel "stored", and the line the page appends for it.
function stored(attachmentsDir, name, { type = "text/plain", bytes = 2048 } = {}) {
  const p = `${attachmentsDir}/${name}`;
  writeFileSync(p, "x".repeat(Math.min(bytes, 64)));
  return { path: p, name, type, bytes };
}

// One turn of the assistant: the reader's message, then the reply the stub streams back.
async function turn(p, { message, reply }) {
  p.gw.setReply(reply);
  const said = await p.assistant.say(message);
  const done = await p.settled(said.id);
  assert.ok(done, "the assistant's turn finished");
  return done;
}

// Every child the harvest started, oldest first.
function spawnedChildren(jobs) {
  return [...jobs.jobs.values()].filter((j) => j.origin?.kind === "assistant-spawn");
}

test("an attached file on the reader's message reaches the worker the assistant spawns", async (t) => {
  const p = await panel(t);
  const shot = stored(p.attachmentsDir, "screenshot.png", { type: "image/png", bytes: 40 * 1024 });
  const brief = stored(p.attachmentsDir, "brief.txt", { type: "text/plain", bytes: 1500 });

  const done = await turn(p, {
    // Exactly what the page sends: the reader's words with the block appended, one line per file.
    message: `Have a look at these and start a worker on it.${attachmentBlock([shot, brief])}`,
    reply: [`SPAWN IN ${p.tree} | read both files and write the summary`, "NOTE: handed the two files on."],
  });
  assert.ok(/read both files/.test(done.lines.map((l) => l.text).join("\n")), "the reply carried the SPAWN line");

  const child = await p.waitChild();
  assert.ok(child, "the SPAWN line started a child");

  // 1. the child's OWN record carries the turn's attachments.
  const recorded = (child.attachments || []).map((a) => slash(a.path)).sort();
  assert.deepEqual(recorded, [slash(shot.path), slash(brief.path)].sort(), "the child record carries both files, via addAttachments");
  await p.settled(child.id);
  const settledChild = p.jobs.jobs.get(child.id);
  assert.deepEqual(
    (settledChild.attachments || []).map((a) => slash(a.path)).sort(),
    [slash(shot.path), slash(brief.path)].sort(),
    "…and they survive the turn",
  );

  // 2. the child's INPUT names each one, in the page's convention.
  const input = p.gw.inputs.get(child.thread) || "";
  assert.ok(input.includes(`Attachment: ${slash(shot.path)} (image/png, 40 KB) — use vision_analyze on it before answering.`), `the image is named for vision: ${input}`);
  assert.ok(input.includes(`Attachment: ${slash(brief.path)} (text/plain, 1 KB) — read_file it before answering.`), `the document is named for read_file: ${input}`);

  // …and the parent's journal says what it handed over, so the assistant can find out on its next wake.
  const handed = p.assistant.journal.filter((e) => e.kind === "attachments");
  assert.equal(handed.length, 1, "one journal line records the inheritance");
  assert.match(handed[0].text, /inherited 2 attachments from the turn: screenshot\.png, brief\.txt/);

  // The display path is untouched: the child's own `prompt` is the brief, not the path block.
  assert.equal(p.jobs.jobs.get(child.id).prompt, "read both files and write the summary", "the card shows the brief, not the machine block");
});

test("an attachment outside the panel's attachments directory is dropped, and the drop is said", async (t) => {
  const p = await panel(t);
  const good = stored(p.attachmentsDir, "inside.txt", { type: "text/plain", bytes: 2048 });
  const outside = { path: slash(path.join(p.dir, "private", "secret.txt")), name: "secret.txt", type: "text/plain", bytes: 900 };
  mkdirSync(path.dirname(outside.path), { recursive: true });
  writeFileSync(outside.path, "not the panel's to hand on\n");

  const done = await turn(p, {
    message: `Use these.${attachmentBlock([good, outside])}`,
    reply: [`SPAWN IN ${p.tree} | use the file the reader attached`, "NOTE: one file was outside the store."],
  });
  const child = await p.waitChild();
  assert.ok(child, "the SPAWN line still started a child");

  // Only the stored file is inherited.
  assert.deepEqual((child.attachments || []).map((a) => slash(a.path)), [slash(good.path)], "only the path the panel stored is inherited");

  const input = p.gw.inputs.get(child.thread) || "";
  assert.ok(input.includes(`Attachment: ${slash(good.path)}`), "the stored file is named in the child's input");
  // No Attachment: LINE for it — the drop statement below names the path on purpose, so "the path appears
  // somewhere" is not the question; "the worker was told to read it" is.
  assert.ok(!input.includes(`Attachment: ${slash(outside.path)}`), `no attachment line names the outside path: ${input}`);
  assert.ok(
    input.includes(`Attachment dropped: ${slash(outside.path)} — it is outside the panel's attachments directory (${p.attachmentsDir}), so it was not inherited.`),
    "the drop is stated, with its reason",
  );

  // The child's card says it too, and so does the journal — a refusal is never a silence.
  const card = (p.jobs.jobs.get(child.id).lines || []).map((l) => String(l.text || "")).join("\n");
  assert.match(card, /attachments directory .* was not inherited/s, "the child's card carries the drop");
  const dropped = p.assistant.journal.filter((e) => e.kind === "attachment-dropped");
  assert.equal(dropped.length, 1, "the drop is journaled once");
  assert.match(dropped[0].text, /secret\.txt/);
});

test("a SPAWN line cannot hand a worker a file by writing its own Attachment: line", async (t) => {
  const p = await panel(t);
  const smuggle = slash(path.join(p.dir, "private", "keys.txt"));
  mkdirSync(path.dirname(smuggle), { recursive: true });
  writeFileSync(smuggle, "id_rsa\n");

  const done = await turn(p, {
    // The reader attached nothing at all. The assistant writes the line into the SPAWN prompt itself.
    message: "Start a worker to tidy the tree.",
    reply: [
      `SPAWN IN ${p.tree} | tidy the tree. ${attachmentLine({ path: smuggle, type: "text/plain", bytes: 900 })}`,
      "NOTE: wrote a path into the brief.",
    ],
  });
  assert.ok(/SPAWN IN/.test(done.lines.map((l) => l.text).join("\n")));
  const child = await p.waitChild();
  assert.ok(child, "the child started");

  assert.deepEqual(child.attachments || [], [], "a SPAWN line's own Attachment: line is not an attachment");
  const input = p.gw.inputs.get(child.thread) || "";
  assert.ok(!input.includes(`Attachment: ${smuggle}`), `no attachment line names the smuggled path: ${input}`);
  assert.ok(input.includes(`Attachment dropped: ${smuggle}`), "…and the drop is stated");
  assert.ok(/tidy the tree/.test(input), "the rest of the brief is untouched");
});

test("a turn with no attachments produces the child input it always produced", async (t) => {
  const p = await panel(t);
  await turn(p, {
    message: "Start a worker on the leftovers.",
    reply: [`SPAWN IN ${p.tree} | tidy the leftover files and say what you found`],
  });
  const child = await p.waitChild();
  assert.ok(child, "the child started");
  const input = p.gw.inputs.get(child.thread) || "";
  assert.deepEqual(child.attachments || [], [], "no attachment is recorded");
  assert.ok(!/Attachment:/.test(input), "no attachment line is in the input");
  assert.ok(!/Attachment dropped:/.test(input), "and nothing is said about a drop that never happened");

  // The shape of the request is the one jobs.create builds from the brief alone: the same prompt through the
  // same store, with the new option empty and with it absent, is the same string once the job's own id (which
  // the scratch line names) is folded out.
  const viaOption = await p.jobs.create({
    prompt: "tidy the leftover files and say what you found",
    cwd: p.tree,
    existing: true,
    worktree: false,
    ownerPath: p.tree,
    attachmentBlock: "",
    notes: [],
    origin: { kind: "assistant-spawn" },
  });
  // One worker per tree: the first comparison run is still live in this tree, so the second create would be
  // refused by the cut's own rule. Wait for the first to settle — the comparison is about the request body, and
  // two live agents in one tree is now exactly what the panel refuses.
  await p.settled(viaOption.id);
  const viaAbsent = await p.jobs.create({
    prompt: "tidy the leftover files and say what you found",
    cwd: p.tree,
    existing: true,
    worktree: false,
    ownerPath: p.tree,
    origin: { kind: "assistant-spawn" },
  });
  const fold = (text, id) => String(text || "").split(id).join("<job>");
  assert.equal(
    fold(p.gw.inputs.get(viaOption.thread), viaOption.id),
    fold(p.gw.inputs.get(viaAbsent.thread), viaAbsent.id),
    "an empty attachment block changes nothing in the request",
  );
});

test("an ask-mode card carries the same files when the reader presses it", async (t) => {
  const p = await panel(t);
  p.assistant.settings.spawn = "ask";
  const file = stored(p.attachmentsDir, "notes.md", { type: "text/markdown", bytes: 3072 });

  await turn(p, {
    message: `Draft a worker for this.${attachmentBlock([file])}`,
    reply: [`SPAWN IN ${p.tree} | read the notes and summarise them`],
  });
  const card = await p.waitFor(() => p.assistant.state().alerts.find((a) => a.spawn && a.status === "open"), 8_000);
  assert.ok(card, "ask mode filed one card");
  assert.deepEqual((card.spawn.attachments || []).map((a) => slash(a.path)), [slash(file.path)], "the card carries the file it will hand on");

  // Nothing was started yet.
  assert.equal(spawnedChildren(p.jobs).length, 0, "an ask-mode card starts nothing");
  const job = await p.assistant.startSpawn(card.spawn, { alertId: card.id, source: "reader" });
  assert.ok(job?.id, "the press started the worker");
  await p.settled(job.id);
  const started = p.jobs.jobs.get(job.id);
  assert.deepEqual((started.attachments || []).map((a) => slash(a.path)), [slash(file.path)], "the pressed child carries it on its record");
  assert.ok((p.gw.inputs.get(started.thread) || "").includes(`Attachment: ${slash(file.path)} (text/markdown, 3 KB) — read_file it before answering.`), "…and names it in its input");
});
