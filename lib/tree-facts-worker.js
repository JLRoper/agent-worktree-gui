import { parentPort, workerData } from "node:worker_threads";
import { ChildTree } from "./child-tree.js";

const scope = "tree-facts";
const children = new ChildTree({
  onTrack: ({ pid, label }) => parentPort.postMessage({ type: "child", pid, label }),
  onDone: ({ pid }) => parentPort.postMessage({ type: "child-done", pid }),
});
let cancelled = false;
parentPort.on("message", (message) => {
  if (message?.type !== "cancel") return;
  cancelled = true;
  void children.killAll("tree facts cancelled");
});

try {
  const run = async (args) => {
    if (cancelled) throw new Error("tree facts cancelled");
    return (await children.exec(scope, "git", ["-C", workerData.treePath, ...args], {
      encoding: "utf8", timeout: 5000, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    })).stdout.trim();
  };
  const commit = await run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const head = await run(["rev-parse", "--short", "HEAD"]);
  const branch = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirty = (await run(["status", "--porcelain"])).split("\n").filter((line) => line.trim()).length;
  parentPort.postMessage({ type: "result", facts: { head, ...(/^[0-9a-f]{40,64}$/i.test(commit) ? { commit: commit.toLowerCase() } : {}), branch, dirty } });
} catch {
  parentPort.postMessage({ type: "result", facts: null });
} finally {
  parentPort.close();
}
