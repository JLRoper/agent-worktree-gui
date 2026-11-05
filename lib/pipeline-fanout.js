// The fan-out model: WHICH stages of a pipeline run in their own tree, and what the aggregator merges.
//
// `docs/design/pipeline-stage-execution.md` §3.1 decided one tree per row and rejected a tree per stage. That
// decision stands for a CHAIN: stages of one continuous piece of work, where each stage finishes what the last one
// started, belong in one workspace and on one branch. It does not stand for a graph's concurrent part. Two stages
// that are siblings — neither reading the other's files — should not take turns in one tree: each should start from
// the same commit, write only the files nobody else writes, and be combined once, at the end, by the stage that
// aggregates them.
//
// That is this module. A pipeline selects it with `isolation: "per-stage"`; the default (`shared`) is exactly
// today's behaviour and this module answers "nothing to fan out" for it.
//
// Six rules decide the shape:
//
//   1. A FAN-OUT BLOCK is a fork, N lanes and a join. The fork is a stage with two or more non-loop handoffs to
//      distinct stages; at a pipeline START (several stages with no inbound edge) the start is the fork and there is
//      no fork stage. The lanes are the fork's successors (or the roots); the join is the earliest stage, in reading
//      order, that every lane can reach over non-loop edges. No join, one lane, or a lane that is itself a fork →
//      there is no block, and the pipeline runs `shared`: the panel does not guess a graph the document did not draw.
//   2. ONE STAGE = ONE LANE = ONE TREE. A lane is ONE stage, not a chain: a lane's own successor is a nested
//      fan-out, which this version refuses by refusing the block. The cost is stated rather than hidden — a lane
//      that wants three stages is three lanes or it is a chain.
//   3. ONE BASE. Every lane tree and the aggregate tree are cut from the SAME commit: the fork stage's settled
//      commit, or — at a pipeline start — the first lane's cut. The base is the only thing about a fan-out that
//      cannot be derived from the bundle, so it is the one thing the row STORES.
//   4. ONE MERGE, AT THE END. The join (the aggregator) is the only stage that reads across. Its tree is cut from
//      the same base and every lane branch is merged into it in ONE merge commit, pre-flighted with
//      `git merge-tree --write-tree` (lib/pipeline-aggregate.js) so a conflict parks the row naming the paths
//      instead of starting a merge that fails halfway.
//   5. STAGE BRANCHES ARE LOCAL ONLY. A lane branch exists on this disk to be merged into the aggregate and never
//      to be pushed: the row's landing branch is the aggregate tree's, and the landing rule (lib/branch-policy.js)
//      speaks about that one. This module never pushes and the aggregate never leaves the repository it merges in.
//   6. A fan-out is described, never enforced. The panel cannot know what a stage will write, so "each stage writes
//      only files nobody else writes" is what the AGGREGATE proves: a lane that wrote a sibling's file conflicts at
//      the pre-flight and parks with the path named. That is the check — not a file-name allowlist the agent would
//      have to be trusted to respect.
const text = (value) => (typeof value === "string" ? value.trim() : "");
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// The two isolation models a pipeline may name. `shared` is the default and is what every bundle written before
// this field existed means: one tree per row, reused by every stage (design §3.1).
export const ISOLATION_SHARED = "shared";
export const ISOLATION_PER_STAGE = "per-stage";
export const ISOLATIONS = Object.freeze([ISOLATION_SHARED, ISOLATION_PER_STAGE]);

// What the record says, read permissively: the loader has already refused a value it does not know
// (lib/pipeline-bundle.js), and this reader's job is to answer one of two models for a bundle that got through.
// A pipeline that predates the field answers `shared`, which is the same object it ran under before.
export function isolationOf(pipeline) {
  const raw = text(pipeline && pipeline.isolation).toLowerCase();
  return raw === ISOLATION_PER_STAGE ? ISOLATION_PER_STAGE : ISOLATION_SHARED;
}

// A non-loop edge is one the driver can take on the rail. `loop` is the capped back edge (rule 4 of the driver) and
// a loop out of a stage is a two-outcome gate, not a lane: the seed's S9 → S8/S10 is exactly that shape, and reading
// it as a fan-out would run both outcomes of a gate the panel is forbidden to decide.
const railEdges = (pipeline) =>
  (Array.isArray(pipeline && pipeline.handoffs) ? pipeline.handoffs : []).filter(
    (handoff) => isObject(handoff) && text(handoff.from) && text(handoff.to) && (text(handoff.kind) || "sequence") !== "loop",
  );

const unique = (list) => [...new Set(list.filter(Boolean))];

// Every stage reachable from `start` over rail edges, the start itself excluded. Bounded by the stage count, so a
// graph with a cycle in its rail (a `return` edge) cannot spin: a seen-set is the walk.
function reachableFrom(pipeline, edges, start) {
  const ids = (Array.isArray(pipeline && pipeline.order) ? pipeline.order : []).map(text).filter(Boolean);
  const seen = new Set();
  const queue = [text(start)];
  while (queue.length) {
    const at = queue.shift();
    for (const edge of edges) {
      if (text(edge.from) !== at) continue;
      const to = text(edge.to);
      if (!to || to === text(start) || seen.has(to) || !ids.includes(to)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  return seen;
}

// The fan-out block a pipeline draws, or null when it draws none.
//
//   { isolate: true, fork, lanes, join, block, why }   a real block: fork may be null (a pipeline start)
//   null                                                no block — the caller runs the row `shared`
//
// `why` is set only when the graph LOOKS like a fan-out and is refused (a nested fork, a lane that loops), so a
// reader can see the refusal instead of inferring it from a null.
export function fanOutOf(pipeline) {
  if (!isObject(pipeline)) return null;
  const order = (Array.isArray(pipeline.order) ? pipeline.order : (pipeline.stages || []).map((s) => s && s.id)).map(text).filter(Boolean);
  if (order.length < 2) return null;
  const edges = railEdges(pipeline);
  const outgoing = (id) => unique(edges.filter((edge) => text(edge.from) === text(id)).map((edge) => text(edge.to)));
  const incoming = (id) => unique(edges.filter((edge) => text(edge.to) === text(id)).map((edge) => text(edge.from)));

  // A fork is a stage with two or more distinct rail successors. Two forks in one pipeline is two blocks, and this
  // version models one block per pipeline: it refuses rather than picking one and silently sharing the other.
  const forks = order.filter((id) => outgoing(id).length >= 2);
  if (forks.length > 1) return { isolate: false, why: `the graph forks at ${forks.join(", ")} — this version models one fan-out block per pipeline, so the row runs shared` };

  let fork = null;
  let lanes = [];
  if (forks.length === 1) {
    fork = forks[0];
    lanes = outgoing(fork);
  } else {
    // A pipeline start with several roots is a fan-out whose fork is the start itself: the lanes all begin at the
    // row's base, which is the only base there is.
    const roots = order.filter((id) => incoming(id).length === 0);
    if (roots.length < 2) return null;
    lanes = roots;
  }
  if (lanes.length < 2) return null;

  // A lane must not be another lane's ancestor: that is a chain wearing two lane names, and merging both would
  // merge the same commit twice.
  for (const lane of lanes) {
    const reach = reachableFrom(pipeline, edges, lane);
    if (lanes.some((other) => other !== lane && reach.has(other))) {
      return { isolate: false, why: `lane ${lane} reaches lane ${lanes.find((other) => other !== lane && reach.has(other))} — two lanes cannot be one chain, so the row runs shared` };
    }
  }
  // A lane that forks again is a nested block. Refused by name rather than flattened: "one stage = one lane" is the
  // model, and a nested fork would need a second aggregate inside the first.
  for (const lane of lanes) {
    if (outgoing(lane).length >= 2) return { isolate: false, why: `lane ${lane} forks again — this version runs one flat fan-out, so the row runs shared` };
  }

  const forward = new Map(lanes.map((lane) => [lane, reachableFrom(pipeline, edges, lane)]));
  const join = order.find((id) => id !== fork && lanes.every((lane) => forward.get(lane).has(id))) || null;
  if (!join) return { isolate: false, why: `the lanes ${lanes.join(", ")} never converge on one stage — there is nothing to aggregate, so the row runs shared` };
  if (lanes.includes(join)) return { isolate: false, why: `stage ${join} is both a lane and the join` };
  // A lane is ONE stage whose only successor is the join. A lane that reaches the join through a stage in between
  // would leave that stage without a tree of its own while the driver jumped over it — the one way this model could
  // silently drop a stage, so it is refused rather than flattened.
  for (const lane of lanes) {
    const out = outgoing(lane);
    if (out.length !== 1 || out[0] !== join) {
      return { isolate: false, why: `lane ${lane} hands off to ${out.length ? out.join(", ") : "nothing"}, not to the join ${join} — a lane is one stage, so the row runs shared` };
    }
  }

  return { isolate: true, fork, lanes, join, block: [...(fork ? [fork] : []), ...lanes, join], why: null };
}

// What one stage of a fanned-out pipeline is, for the driver and for a reader:
//   `fork`  — the stage whose commit is the block's base (it runs in the row's tree)
//   `lane`  — one concurrent stage, in its own tree cut from the base
//   `join`  — the aggregator, in its own tree cut from the base, where the one merge lands
//   null    — not part of a block (a chain stage, or a `shared` pipeline)
export function stageRoleOf(plan, stageId) {
  const id = text(stageId);
  if (!plan || !plan.isolate || !id) return null;
  if (plan.fork && id === plan.fork) return "fork";
  if (id === plan.join) return "join";
  if (plan.lanes.includes(id)) return "lane";
  return null;
}

// The commit every tree of the block is cut from. Stored on the row when the first tree is cut (rule 3); derived
// from the fork's settled run before that, because the fork's own settle is what proved the base. Answers null for
// a pipeline-start fan-out whose first lane has not been cut yet — that cut SUPPLIES the base.
export function fanOutBaseOf(run, plan, stageRunsOf) {
  const stored = text(run && run.fanout && run.fanout.base);
  if (stored) return stored;
  if (!plan || !plan.isolate || !plan.fork) return null;
  const runs = typeof stageRunsOf === "function" ? stageRunsOf(run) : [];
  const forkRun = [...runs].reverse().find((entry) => text(entry.stage) === plan.fork && text(entry.commit));
  return forkRun ? text(forkRun.commit) : null;
}

// The lane branches the aggregate merges, pinned: the commit a lane settled at, its branch (the tree it ran in) and
// the artifact it produced. A branch alone is not enough — it resolves differently tomorrow — so `commit` is what the
// aggregate takes and the branch is what a reader recognises.
export function aggregateBranchesOf(run, plan, stageRunsOf) {
  if (!plan || !plan.isolate) return { ok: false, why: "the pipeline has no fan-out block to aggregate" };
  const runs = typeof stageRunsOf === "function" ? stageRunsOf(run) : [];
  const branches = [];
  const missing = [];
  for (const lane of plan.lanes) {
    const settled = [...runs].reverse().find((entry) => text(entry.stage) === lane && text(entry.status) === "done");
    if (!settled) {
      missing.push(lane);
      continue;
    }
    const commit = text(settled.commit) || text(settled.tree && settled.tree.commit);
    const branch = text(settled.tree && settled.tree.branch);
    if (!commit || !branch) {
      missing.push(lane);
      continue;
    }
    branches.push({
      stage: lane,
      branch,
      commit,
      artifact: isObject(settled.artifact) ? text(settled.artifact.id) || null : null,
      path: isObject(settled.artifact) ? text(settled.artifact.path) || null : null,
      sha256: isObject(settled.artifact) ? text(settled.artifact.sha256) || null : null,
      blob: isObject(settled.artifact) ? text(settled.artifact.blob) || null : null,
    });
  }
  if (missing.length) return { ok: false, why: `the lanes ${missing.join(", ")} have not settled in their own trees yet — there is nothing to merge` };
  return { ok: true, branches };
}

// The merge's subject and its record. One string, so the commit a reader sees and the row's own `merge` entry say
// the same thing: which single commit combined which lanes, from which base.
export function aggregateMessage(pipeline, plan, branches, base) {
  const names = branches.map((branch) => branch.stage).join(", ");
  const head = `stage ${plan.join}: aggregate ${branches.length} stage branch${branches.length === 1 ? "" : "es"} (${names})`;
  return `${head} from base ${text(base) ? String(base).slice(0, 12) : "(unknown)"}`;
}

// The record the aggregate writes on the join's stage run: the commit it made, the lanes it merged and their pins.
// It is the PROOF that the merge happened once — the driver refuses a second aggregate when this is present.
export function aggregateRecord({ commit, base, branches, at = null, tree = null, verified = false }) {
  return {
    commit: text(commit) || null,
    base: text(base) || null,
    ...(tree ? { tree } : {}),
    ...(at ? { at } : {}),
    ...(verified ? { verified: true } : {}),
    branches: (Array.isArray(branches) ? branches : []).map((branch) => ({
      stage: text(branch.stage) || null,
      branch: text(branch.branch) || null,
      commit: text(branch.commit) || null,
      artifact: text(branch.artifact) || null,
      path: text(branch.path) || null,
      sha256: text(branch.sha256) || null,
    })),
  };
}
