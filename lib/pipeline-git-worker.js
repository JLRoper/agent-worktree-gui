import { parentPort, workerData } from "node:worker_threads";
import { commitOf, pinCheck, pinOf, workingBlobOf } from "./stage-pin.js";

const operations = { commitOf, pinCheck, pinOf, workingBlobOf };

try {
  const fn = operations[workerData.operation];
  if (!Object.hasOwn(operations, workerData.operation)) throw new Error("unknown pipeline git operation");
  parentPort.postMessage({ result: fn(...workerData.args) });
} catch (error) {
  parentPort.postMessage({ error: String(error?.message || error) });
} finally {
  parentPort.close();
}
