// Worker thread: one git scan per message, off the main thread.
import { parentPort } from "node:worker_threads";
import { scanWorktree } from "./scan.js";

parentPort.on("message", async (msg) => {
  try {
    const row = await scanWorktree(msg.wtPath, msg.ctx || {}, msg.depth || "fast");
    parentPort.postMessage({ id: msg.id, ok: true, row });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, ok: false, error: String((e && e.message) || e) });
  }
});
