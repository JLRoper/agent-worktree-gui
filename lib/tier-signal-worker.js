import { parentPort, workerData } from "node:worker_threads";
import { statSignalSync } from "./tiers.js";

try {
  parentPort.postMessage({ signal: statSignalSync(workerData.repoPath) });
} catch (error) {
  parentPort.postMessage({ error: String(error?.message || error) });
}
