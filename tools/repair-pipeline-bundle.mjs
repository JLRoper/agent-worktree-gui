#!/usr/bin/env node
// Repair a live pipeline bundle whose gates are AMBIGUOUS, keeping the reader's own document.
//
//   node tools/repair-pipeline-bundle.mjs                 # show what would change (the install's own bundle)
//   node tools/repair-pipeline-bundle.mjs --write         # apply it, through a temporary and a rename
//   node tools/repair-pipeline-bundle.mjs --file <path>   # another bundle (a sandbox's state folder, a copy)
//   node tools/repair-pipeline-bundle.mjs --model <path>  # the shipped seed it copies routes from (default: this checkout's)
//
// The file this reads is the one the panel reads: `config.pipelineBundleFile`, resolved by lib/paths.js from the same
// config the server loads, so the tool and the panel cannot disagree about which bundle is live. `--file` overrides it
// for a copy.
//
// Three rules the script keeps, matching lib/pipeline-bundle-repair.js:
//   1. It copies routes from the shipped seed's SAME pipeline and gate, and only when they name handoffs the live
//      pipeline holds leaving that gate. Nothing is guessed; an outcome the seed does not answer refuses the run.
//   2. A gate with one way out (or none) is left alone: the loader accepts it, and the row takes that road anyway.
//   3. The repaired document goes through `parseBundle` before a byte is written, so "repaired" means the panel's own
//      loader accepts it.
//
// Exit: 0 nothing to do, or the repair was written; 1 the plan was refused (nothing written); 2 a bad argument or no
// bundle at the path.
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { planBundleRepair, readRepairModel } from "../lib/pipeline-bundle-repair.js";
import { resolveLayout } from "../lib/paths.js";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] ?? fallback : fallback);
const WRITE = argv.includes("--write");
const QUIET = argv.includes("--quiet");

const die = (message, code = 1) => {
  process.stderr.write(`repair-pipeline-bundle: ${message}\n`);
  process.exit(code);
};

if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(
    "repair-pipeline-bundle: give the ambiguous gates of a live pipeline bundle the routes the shipped seed declares\n" +
      "  --file <path>   the bundle to repair (default: this install's config.pipelineBundleFile)\n" +
      "  --model <path>  the seed the routes come from (default: pipeline-bundle.seed.json beside this checkout)\n" +
      "  --write         apply the plan (default is a dry run, which writes nothing)\n" +
      "  --quiet         only the last line\n",
  );
  process.exit(0);
}

const layout = resolveLayout({ here: HERE });
const file = path.resolve(opt("--file", layout.paths.pipelineBundleFile));
const modelFile = path.resolve(opt("--model", path.join(HERE, "pipeline-bundle.seed.json")));

if (!existsSync(file)) die(`there is no bundle at ${file} — nothing to repair`, 2);
if (!existsSync(modelFile)) die(`there is no model at ${modelFile} — pass --model`, 2);

let body;
try {
  body = readFileSync(file, "utf8");
} catch (error) {
  die(`${file} could not be read (${String((error && error.message) || error)})`, 2);
}

let doc;
try {
  doc = JSON.parse(body.replace(/^\uFEFF/, ""));
} catch (error) {
  // Not JSON is not this tool's to repair: a half-written file is a file to restore, and guessing one would be the
  // opposite of the rule that a refusal is a value.
  die(`${file} is not JSON (${String((error && error.message) || error)}) — this tool repairs a readable bundle's gates, not its syntax`, 1);
}

const model = readRepairModel(modelFile);
if (model.ok !== true) die(`the model cannot be used: ${model.reason}`, 1);

const plan = planBundleRepair(doc, { model, file });
if (plan.ok !== true) {
  process.stderr.write(`repair-pipeline-bundle: refused — ${plan.code}${plan.where ? ` at ${plan.where}` : ""}: ${plan.reason}\n`);
  if (!QUIET) process.stderr.write(`  nothing was written; ${file} is byte-for-byte as it was\n`);
  process.exit(1);
}

const routed = plan.changes.filter((change) => change.kind === "routes");
const pauses = plan.changes.filter((change) => change.kind === "pause");
const notRequired = plan.changes.filter((change) => change.kind === "not-required");
const lines = plan.changes.map((change) => {
  const gate = `pipeline ${change.pipeline} gate ${change.gate}`;
  if (change.kind === "routes") return `  routed ${gate} — ${JSON.stringify(change.routes)}`;
  if (change.kind === "pause") return `  explicit null: ${gate} declares no decision, so it is a pause`;
  return `  left alone: ${gate} follows a stage with one way out, so the loader needs no map`;
});

if (!routed.length && !pauses.length) {
  process.stdout.write(`repair-pipeline-bundle: nothing to repair in ${file} — ${plan.pipelines.length} pipelines load\n`);
  if (!QUIET) process.stdout.write(lines.join("\n") + (lines.length ? "\n" : ""));
  process.exit(0);
}

if (!WRITE) {
  process.stdout.write(`repair-pipeline-bundle: dry run for ${file} — ${routed.length} gate(s) to route, ${pauses.length} made explicit\n`);
  if (!QUIET) process.stdout.write(`${lines.join("\n")}\n`);
  process.stdout.write(`  re-run with --write to apply it (a temporary beside the file, then a rename)\n`);
  process.exit(0);
}

const text = `${JSON.stringify(doc, null, 2)}\n`;
const tmp = `${file}.repairing-${process.pid}-${Date.now()}`;
try {
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
} catch (error) {
  try {
    unlinkSync(tmp);
  } catch {
    /* the failed write's own leftovers, if any */
  }
  die(`${file} could not be written (${String((error && error.message) || error)}) — it is byte-for-byte as it was`, 1);
}

process.stdout.write(`repair-pipeline-bundle: wrote ${file} — ${routed.length} gate(s) routed, ${pauses.length} made explicit\n`);
if (!QUIET) process.stdout.write(`${lines.join("\n")}\n`);
process.stdout.write(`  ${plan.pipelines.length} pipelines load: ${plan.pipelines.map((pipeline) => `${pipeline.id} (${pipeline.stages} stages)`).join(", ")}\n`);
