#!/usr/bin/env node
// ONE STAGE OF THE 24-STAGE POC-BREAKING ROUNDS DOCUMENT — the seat a stage's prompt is handed to.
//
// Not a model. A scripted seat with a stated remit: the PANEL's driver decides which stage runs, in which tree, on
// which visit; this file writes the artifact that stage declares in the document, commits it, and exits with a status
// the job store can read. It is handed the stage id and the artifact path the DRIVER resolved out of the bundle, so
// the routing is never this file's to choose — it only fills in the file the document says the stage produces.
//
//   node tools/pipeline-exec-stage-seat.mjs --stage S191 --artifact "out/{{run_id}}/r{{round}}/round-brief.json" \
//        --visit 2 --tree <dir> --run run-1 --round 2
//
// THE TWO HOLES the document's artifact paths carry are the seat's to fill: `{{run_id}}` is one id for the whole run
// (the campaign's name for this pass) and `{{round}}` is the round the row is in. The driver's matcher accepts any one
// segment for a hole, so writing the resolved names is what makes the path resolvable afterwards.
//
// THE BYTES carry no timestamp and no absolute path: a stage's artifact is a fact about the stage, and two visits of
// the same stage must be comparable by content. `visit` and `round` ARE in the bytes, because a round that wrote the
// same brief twice would be the one thing the loop exists to detect.
//
// Exit: 0 the artifact was written and committed; 3 the artifact could not be committed (a real stage failure, which
// the panel parks); 2 a bad argument.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : argv[at + 1] ?? fallback;
};

const STAGE = String(arg("--stage", "")).trim();
const ARTIFACT = String(arg("--artifact", "")).trim();
const VISIT = Number(arg("--visit", "1")) || 1;
const ROUND = Number(arg("--round", "1")) || 1;
const RUN = String(arg("--run", "run-1")).trim();
const PIPELINE = String(arg("--pipeline", "poc-breaking-rounds")).trim();
const TREE = path.resolve(String(arg("--tree", process.cwd())));

if (!STAGE || !ARTIFACT) {
  console.error("pipeline-exec-stage-seat: --stage and --artifact are required");
  process.exit(2);
}

const rel = ARTIFACT.replace(/\{\{run_id\}\}/g, RUN).replace(/\{\{round\}\}/g, String(ROUND)).replace(/\\/g, "/");
const target = path.join(TREE, ...rel.split("/"));
mkdirSync(path.dirname(target), { recursive: true });

// The seat's own record of the stage: what it was asked for, on which visit, in which round. Deterministic, so the
// ledger's two hashes for a stage visited twice can be compared without a clock or a path in the way.
const body = {
  pipeline: PIPELINE,
  stage: STAGE,
  visit: VISIT,
  round: ROUND,
  run: RUN,
  seat: "pipeline-exec-stage-seat",
  outputs: [],
};
const bytes = rel.endsWith(".html")
  ? `<!doctype html>\n<meta charset="utf-8">\n<title>${PIPELINE} ${STAGE} r${ROUND}</title>\n<h1>${STAGE} — round ${ROUND}, visit ${VISIT}</h1>\n<p>Written by the stage seat for ${PIPELINE}/${STAGE}.</p>\n`
  : `${JSON.stringify(body, null, 2)}\n`;
writeFileSync(target, bytes);

const git = (...args) =>
  execFileSync("git", ["-C", TREE, "-c", "user.name=Stage Seat", "-c", `user.email=${["seat", "example.invalid"].join(String.fromCharCode(64))}`, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();

git("add", "--", rel);
const status = git("status", "--porcelain", "--", rel);
if (status) {
  git("commit", "-m", `${STAGE} visit ${VISIT} (round ${ROUND}): ${rel}`);
}
const commit = git("rev-parse", "HEAD");
const sha256 = createHash("sha256").update(bytes).digest("hex");
console.log(JSON.stringify({ ok: true, stage: STAGE, visit: VISIT, round: ROUND, artifact: rel, sha256, bytes: bytes.length, commit }));
