// Seed the panel's pipeline bundle from the studio's own export, so a fresh install has one true pipeline to show.
//
//   node tools/seed-pipeline-bundle.mjs                 # write the shipped seed beside the job store
//   node tools/seed-pipeline-bundle.mjs --force         # replace a bundle that is already there
//   node tools/seed-pipeline-bundle.mjs --file <path>   # write somewhere else (a sandbox's state folder)
//
// The seed at the repo root, `pipeline-bundle.seed.json`, is the pipeline studio's OWN export of its 13-stage
// POC-to-UAT project (`exportBundle(pipeline.seed.json).files.pipeline`), not a hand-written copy: the panel must be
// able to read what the studio really emits, and a fixture assembled to suit the loader proves nothing about that.
//
// Two rules the script keeps:
//   1. It VALIDATES before it writes. A seed the panel's own loader refuses is not copied — the script prints the
//      loader's code and locator and exits non-zero, because a bundle on disk that the window reads as unresolved is
//      worse than no bundle at all.
//   2. It never overwrites state by accident. An existing `pipeline-bundle.json` is left alone unless `--force` is
//      given: a reader who has re-exported from their own studio must not lose that file to a boot script.
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseBundle } from "../lib/pipeline-bundle.js";
import { resolveLayout } from "../lib/paths.js";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);

const layout = resolveLayout({ here: HERE });
const source = path.resolve(opt("--source", path.join(HERE, "pipeline-bundle.seed.json")));
const target = path.resolve(opt("--file", layout.paths.pipelineBundleFile));
const force = argv.includes("--force");

const die = (message, code = 1) => {
  process.stderr.write(`seed-pipeline-bundle: ${message}\n`);
  process.exit(code);
};

if (!existsSync(source)) die(`no seed at ${source}`);
const body = readFileSync(source, "utf8");
const loaded = parseBundle(body, { file: source });
if (loaded.ok !== true) {
  die(`the seed at ${source} is not a bundle this panel can read — ${loaded.code}${loaded.where ? ` at ${loaded.where}` : ""}: ${loaded.reason}`);
}

if (existsSync(target) && !force) {
  const same = (() => {
    try {
      return statSync(target).size === statSync(source).size && readFileSync(target, "utf8") === body;
    } catch {
      return false;
    }
  })();
  if (same) {
    process.stdout.write(`seed-pipeline-bundle: already seeded at ${target}\n`);
    process.exit(0);
  }
  die(`${target} already exists — leave it alone, or pass --force to replace it with the shipped seed`);
}

copyFileSync(source, target);
const pipeline = loaded.bundle.pipelines[0];
process.stdout.write(
  `seed-pipeline-bundle: wrote ${target}\n` +
    `  ${loaded.bundle.name}: ${pipeline.stages.length} stages ${pipeline.order[0]}..${pipeline.order[pipeline.order.length - 1]}, ` +
    `${pipeline.gates.length} gates, ${pipeline.handoffs.length} handoffs\n` +
    `  from ${source} — the studio's export, read by the panel's own loader\n`,
);
