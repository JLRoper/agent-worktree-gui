import { parentPort, workerData } from "node:worker_threads";
import { readQueueFile } from "./assistant/queue.js";
import { roundTreeNames } from "./round-tree-names.js";

parentPort.postMessage(workerData.map((file) => [file, [...roundTreeNames(readQueueFile(file).tasks)]]));
