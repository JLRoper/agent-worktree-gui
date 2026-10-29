// Where does this panel keep its files? Prints ONE folder, worked out by the code the server itself runs
// (lib/paths.js), so a launcher script cannot disagree with the server about it:
//
//   node tools/where.mjs logs      the folder holding server.pid, server.out.log and server.err.log   (the default)
//   node tools/where.mjs data      the data directory
//   node tools/where.mjs state     the folder holding the job store
//   node tools/where.mjs scratch   the scratch directory
//   node tools/where.mjs config    the config file this panel will read
//   node tools/where.mjs --json    everything above, as one JSON object
//
// start-background.cmd and stop-background.cmd call it. They used to guess from %WAG_HOME%, which is wrong for an
// install that names `dataDir` in config.json (the config wins over the environment) and for a PANEL_CONFIG instance
// (which keeps its own folder and ignores the environment). The one line it prints is the answer and nothing else:
// a batch `for /f` reads it.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLayout } from "../lib/paths.js";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const layout = resolveLayout({ here });
const answers = {
  logs: layout.paths.logsDir,
  data: layout.paths.dataDir,
  state: layout.paths.stateDir,
  scratch: layout.dirs.scratchDir,
  config: layout.configFile.path,
};

const want = String(process.argv[2] || "logs").replace(/^--?/, "").toLowerCase();
if (want === "json") {
  process.stdout.write(`${JSON.stringify({ ...answers, source: layout.dirs.dataSource, layout: layout.dirs.dataLayout }, null, 2)}\n`);
} else if (Object.hasOwn(answers, want)) {
  process.stdout.write(`${answers[want]}\n`);
} else {
  process.stderr.write(`where.mjs: unknown folder "${want}" — one of ${Object.keys(answers).join(", ")}, or --json\n`);
  process.exitCode = 2;
}
