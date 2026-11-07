// A MESSAGE line carries the sender turn's files.
//
// The defect: `say()` took no attachments, so the Director's MESSAGE line — `MESSAGE <assistant> | …` — sent
// the sentence and stopped. A file the reader dropped on the Director's turn (an image, a brief) reached the
// Director and died there: the assistant it messaged never had it on its card, never read a path for it in
// its input, and the worker that assistant then started inherited nothing.
//
// What this file drives, end to end inside one panel, with the REAL store and the REAL gateway client:
//
//   the reader's turn on the Director (`say`, the page's own `Attachment:` block appended)
//     -> the Director replies with a MESSAGE line
//     -> the harvest applies it -> `say` on the RECEIVING assistant's thread
//     -> the receiving turn's record carries the file (the card's chips) and its input names it, with the
//        instruction the type earns (vision_analyze for an image, read_file for a document)
//     -> the receiving assistant's own SPAWN inherits it, so the worker gets it too.
//
// The boundary is the same one a SPAWN holds, and it is pinned here as well:
//
//   * only a path inside config.attachmentsDir is inherited, whatever named it — the sender's record, the
//     page's block on its prompt, or an `Attachment:` line the MESSAGE itself wrote;
//   * a refused path is NAMED: in the receiver's input, on the receiver's card and in the journal;
//   * a MESSAGE line that wrote its own `Attachment:` line cannot smuggle a path past the gate, and the
//     sentence it wrote is not rewritten (only the panel's format is taken out of it);
//   * a turn with no attachments produces the receiving turn it always produced — byte for byte.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { Jobs } from "../lib/jobs.js";
import { Assistant, ASSISTANT_THREAD } from "../lib/assistant.js";
import { PRIMARY_ASSISTANT, threadFor } from "../lib/assistants.js";
import { ASSISTANT_DIRECTOR_ID } from "../lib/roles.js";
import { attachmentBlock, attachmentLine } from "../lib/attachments.js";
import { createSpawn } from "../lib/features/spawn.js";

const DIRECTOR = "assistant-2";
const DIRECTOR_THREAD = threadFor(DIRECTOR);
const slash = (p) => String(p).replace(/\\/g, "/");
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// ---- a stub gateway ---------------------------------------------------------------------------------
// POST /v1/runs records the run's input against its session; GET .../events streams the reply that was set
// for that SESSION and ends the run. Everything the panel needs and nothing else.
async function stubGateway() {
  const runs = new Map(); // run id -> { thread, input }
  const inputs = new Map(); // thread -> the input its LAST run was sent
  const replies = new Map(); // thread -> the paragraphs the assistant answers with
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
        const lines = replies.get(run.thread) || ["done"];
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
    setReply: (thread, lines) => replies.set(thread, lines.slice()),
    close: () => new Promise((done) => server.close(done)),
  };
}

// ---- the panel: a real store, a real assistant, the real spawner, a Director -------------------------
async function panel(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-attach-message-"));
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
  // #1 is the receiving assistant; the Director is the sender, and its own turn runs on its own thread.
  assistant.createAssistant({ roleId: ASSISTANT_DIRECTOR_ID });

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
  // The turn the MESSAGE line started on the receiving assistant's thread. It exists the moment `say` records
  // it, and finishes when its run does — "it exists" is not "it is the turn".
  const waitMessage = () =>
    waitFor(() => {
      const j = [...jobs.jobs.values()].find((x) => x.origin?.kind === "assistant-message");
      return j && j.status !== "starting" && j.status !== "running" ? j : null;
    }, 15_000);

  t.after(async () => {
    for (const timer of ["wakeTimer", "settleTimer", "timer"]) if (assistant[timer]) clearTimeout(assistant[timer]);
    await gw.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  return { dir, gw, attachmentsDir, tree, jobs, assistant, events, waitFor, settled, waitMessage };
}

// A file the panel "stored", and the record the page's block is written from.
function stored(attachmentsDir, name, { type = "text/plain", bytes = 2048 } = {}) {
  const p = `${attachmentsDir}/${name}`;
  writeFileSync(p, "x".repeat(Math.min(bytes, 64)));
  return { path: p, name, type, bytes };
}

// One turn of the Director: what the reader said (with the page's block, as the browser sends it), then the
// reply the stub streams back into the harvest.
async function directorTurn(p, { message, reply }) {
  p.gw.setReply(DIRECTOR_THREAD, reply);
  const said = await p.assistant.say(message, { assistantId: DIRECTOR });
  const done = await p.settled(said.id);
  assert.ok(done, "the Director's turn finished");
  return done;
}

// The page's own turn listing, run over the receiving turn: the chips are what the reader sees under a prompt.
// Grabbed from public/app.js by name so this is the card's renderer, not a second copy of it.
function turnListHtml(turn) {
  const page = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const m = /(?:^|\n)function turnAttachmentsHtml\(/.exec(page);
  assert.ok(m, "the page carries turnAttachmentsHtml()");
  const start = m.index + (m[0].startsWith("\n") ? 1 : 0);
  const end = page.indexOf("\n}\n", start);
  const src = page.slice(start, end + 3);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  return vm.runInNewContext(`${src}\nturnAttachmentsHtml(turn);`, { turn, esc });
}

test("an image on the Director's turn reaches the assistant it messages — and the worker that assistant starts", async (t) => {
  const p = await panel(t);
  const shot = stored(p.attachmentsDir, "screenshot.png", { type: "image/png", bytes: 40 * 1024 });

  // The reader's message, exactly as the page sends it: the words, then one line per file. The receiving
  // assistant's own reply is prepared first: its turn is the one this message starts, and it answers by
  // starting a worker on the file it was handed.
  p.gw.setReply(ASSISTANT_THREAD, [`SPAWN IN ${p.tree} | read the screenshot and write the summary`]);
  await directorTurn(p, {
    message: `Have a look at this and hand it on.${attachmentBlock([shot])}`,
    reply: [`MESSAGE assistant-1 | the reader's screenshot is on your turn — start a worker to read it.`],
  });

  const received = await p.waitMessage();
  assert.ok(received, "the MESSAGE line started a turn on the receiving assistant's thread");
  assert.equal(received.thread, ASSISTANT_THREAD, "…on Assistant #1's own thread");
  assert.equal(received.assistantId, PRIMARY_ASSISTANT, "…stamped with its assistant");

  // 1. the receiving turn's own record carries the file — the chips the card draws under the prompt.
  assert.deepEqual((received.attachments || []).map((a) => slash(a.path)), [slash(shot.path)], "the receiving turn carries the file");
  const html = turnListHtml(received);
  assert.match(html, /data-open-path="[^"]*screenshot\.png"/, `the receiving turn lists the file: ${html}`);
  assert.match(html, /\[screenshot\.png\]/, "…by name");

  // 2. the receiving turn's INPUT names it, in the page's convention, with the instruction an image earns.
  const input = p.gw.inputs.get(received.thread) || "";
  assert.ok(
    input.includes(`Attachment: ${slash(shot.path)} (image/png, 40 KB) — use vision_analyze on it before answering.`),
    `the image is named for vision: ${input}`,
  );
  // The card shows the words, not the machine block; the block rides in the run's input.
  assert.doesNotMatch(received.prompt, /Attachment:/, "the card's prompt is the message, not the path block");
  assert.equal(received.prompt, "message from Assistant #2: the reader's screenshot is on your turn — start a worker to read it.");
  assert.match(input, /\[Assistant #2 → you\] the reader's screenshot is on your turn/);

  // 3. the journal says what was handed over, on the RECEIVING thread, so either assistant can find it out.
  const handed = p.assistant.journal.filter((e) => e.kind === "attachments" && e.thread === ASSISTANT_THREAD);
  assert.equal(handed.length, 1, "one journal line records the inheritance on the receiving thread");
  assert.match(handed[0].text, /inherited 1 attachment from the turn: screenshot\.png/);
  assert.ok(
    p.assistant.journal.some((e) => e.kind === "messaged" && e.thread === ASSISTANT_THREAD),
    "and the message itself is journalled",
  );

  // 4. the worker the RECEIVING assistant starts inherits it too — the second half of the brief: the turn's
  // record is what `spawnInheritance` reads, so the file arrives at the worker without being retyped.
  const child = await p.waitFor(() => {
    const c = [...p.jobs.jobs.values()].find((j) => j.origin?.kind === "assistant-spawn");
    return c && c.status !== "starting" && c.status !== "running" ? c : null;
  }, 15_000);
  assert.ok(child, "the receiving turn's SPAWN line started a worker");
  assert.deepEqual((child.attachments || []).map((a) => slash(a.path)), [slash(shot.path)], "the worker inherits the file from the receiving turn");
  assert.ok(
    (p.gw.inputs.get(child.thread) || "").includes(`Attachment: ${slash(shot.path)} (image/png, 40 KB) — use vision_analyze on it before answering.`),
    "…and names it in its own input",
  );
});

test("a path outside the panel's attachments directory is refused, and the refusal is named", async (t) => {
  const p = await panel(t);
  const good = stored(p.attachmentsDir, "inside.txt", { type: "text/plain", bytes: 2048 });
  const outside = { path: slash(path.join(p.dir, "private", "secret.txt")), name: "secret.txt", type: "text/plain", bytes: 900 };
  mkdirSync(path.dirname(outside.path), { recursive: true });
  writeFileSync(outside.path, "not the panel's to hand on\n");

  await directorTurn(p, {
    message: `Two files for #1.${attachmentBlock([good, outside])}`,
    reply: [`MESSAGE assistant-1 | both files are on your turn.`],
  });
  const received = await p.waitMessage();
  assert.ok(received, "the MESSAGE line still started a turn");

  // Only the stored file is inherited, on the record and in the input.
  assert.deepEqual((received.attachments || []).map((a) => slash(a.path)), [slash(good.path)], "only the path the panel stored is inherited");
  const input = p.gw.inputs.get(received.thread) || "";
  assert.ok(input.includes(`Attachment: ${slash(good.path)}`), "the stored file is named in the receiver's input");
  assert.ok(!input.includes(`Attachment: ${slash(outside.path)}`), `no attachment line names the outside path: ${input}`);
  assert.ok(
    input.includes(`Attachment dropped: ${slash(outside.path)} — it is outside the panel's attachments directory (${p.attachmentsDir}), so it was not inherited.`),
    "the refusal is stated, with its reason",
  );

  // On the card too, and in the journal — a refusal is never a silence.
  const card = (received.lines || []).map((l) => String(l.text || "")).join("\n");
  assert.match(card, /attachments directory .* was not inherited/s, "the receiving turn's card carries the refusal");
  const dropped = p.assistant.journal.filter((e) => e.kind === "attachment-dropped" && e.thread === ASSISTANT_THREAD);
  assert.equal(dropped.length, 1, "the refusal is journalled once, on the receiving thread");
  assert.match(dropped[0].text, /secret\.txt/);
});

test("a MESSAGE line cannot hand on a file by writing its own Attachment: line", async (t) => {
  const p = await panel(t);
  const smuggle = slash(path.join(p.dir, "private", "keys.txt"));
  mkdirSync(path.dirname(smuggle), { recursive: true });
  writeFileSync(smuggle, "id_rsa\n");

  // The reader attached nothing; the Director writes the panel's own format into the message.
  await directorTurn(p, {
    message: "Tell #1 the tree is stale.",
    reply: [`MESSAGE assistant-1 | the tree is stale — reread it. ${attachmentLine({ path: smuggle, type: "text/plain", bytes: 900 })}`],
  });
  const received = await p.waitMessage();
  assert.ok(received, "the message still arrived");
  assert.deepEqual(received.attachments || [], [], "a MESSAGE line's own Attachment: line is not an attachment");

  const input = p.gw.inputs.get(received.thread) || "";
  assert.ok(!input.includes(`Attachment: ${smuggle}`), `no attachment line names the smuggled path: ${input}`);
  assert.ok(input.includes(`Attachment dropped: ${smuggle}`), "…and the refusal is stated");
  // The words are the Director's, with the panel's format taken out of them — nothing else is rewritten.
  assert.match(received.prompt, /the tree is stale — reread it\./);
  assert.doesNotMatch(received.prompt, /Attachment:/, "the written path line is gone from the card's prompt");
});

test("a MESSAGE line that is only an Attachment: line is refused by name", async (t) => {
  const p = await panel(t);
  const file = stored(p.attachmentsDir, "notes.md", { type: "text/markdown", bytes: 3000 });
  await directorTurn(p, {
    message: "Hand the notes over.",
    // Nothing but the panel's own line: stripping it leaves no message to send.
    reply: [`MESSAGE assistant-1 | ${attachmentLine(file)}`],
  });
  await p.waitFor(() => p.assistant.journal.some((e) => e.kind === "message-refused"), 6_000);
  const refused = p.assistant.journal.find((e) => e.kind === "message-refused");
  assert.ok(refused, "the line was refused out loud");
  assert.match(refused.text, /only an Attachment: line, and a message needs words/);
  assert.equal([...p.jobs.jobs.values()].filter((j) => j.origin?.kind === "assistant-message").length, 0, "no turn was started");
});

test("a turn with no attachments produces the receiving turn it always produced", async (t) => {
  const p = await panel(t);
  await directorTurn(p, {
    message: "Just a note for #1.",
    reply: [`MESSAGE assistant-1 | nothing to hand over, only words.`],
  });
  const received = await p.waitMessage();
  assert.ok(received, "the message arrived");
  assert.deepEqual(received.attachments || [], [], "no attachment is recorded");
  const input = p.gw.inputs.get(received.thread) || "";
  assert.doesNotMatch(input, /Attachment:/, "no attachment line is in the input");
  assert.doesNotMatch(input, /Attachment dropped:/, "and nothing is said about a refusal that never happened");
  assert.equal(received.prompt, "message from Assistant #2: nothing to hand over, only words.", "the card's line is the message, unchanged");
  assert.match(input, /\[Assistant #2 → you\] nothing to hand over, only words\./);
  assert.equal(p.assistant.journal.filter((e) => e.kind === "attachments").length, 0, "and no inheritance is journalled");
});
