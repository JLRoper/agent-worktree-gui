// ---- from "an agent should run here" to a job on the board ------------------------------------
// Three call sites ask the same question — the New-agent card (POST /api/agents), its preview
// (POST /api/agents/preview) and the assistant's own spawner, which the sentry reaches through
// `spawner` — and each used to answer it with its own copy of the same six steps: find the project,
// decide the directory, resolve a tree a rename may have moved, refuse an unborn HEAD, derive the
// owner path, and decide whether the run stays in the project's own checkout.
//
// The copies had drifted apart, which is the point of moving them: the path normaliser was declared
// twice under two names, and the owner path was derived twice with different fallbacks.
//
// The module reads no singleton. `getConfig()` is called per spawn because /api/reload swaps the
// whole config object; `getProjects()` because every registry refresh replaces the array; `jobs` is
// the store the composition root built. Nothing here touches the store, the scheduler or the HTTP
// layer, and it imports no module that imports it back.
import { gitIn } from "../scan.js";
import { resolveExistingTarget, resolutionNote } from "../spawn-target.js";
import { makeThreadName, previewRequest } from "../hermes-runtime.js";

export function createSpawn({ getConfig, getProjects, jobs }) {
  // The panel's own path key: separators to `/`, no trailing slash, lower case. Windows compares
  // paths case-insensitively and the same tree can be written by either spelling — this is the
  // `normPathKey` the rest of the server uses, kept here as `normPath` because that is the name the
  // two spawn copies had given it.
  const normPath = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

  // Which project a directory belongs to: the innermost project root that contains it (a project can be nested inside
  // another checkout), matched on a path boundary so `…/app-other` is not inside `…/app`.
  const projectForPath = (dir) => {
    const key = normPath(dir);
    if (!key) return null;
    let best = null;
    for (const proj of getProjects()) {
      const root = normPath(proj.path);
      if (!root) continue;
      if (key !== root && !key.startsWith(`${root}/`)) continue;
      if (!best || root.length > normPath(best.path).length) best = proj;
    }
    return best;
  };

  const findProject = (name) => getProjects().find((p) => p.name === name) || null;

  // A worktree branches from HEAD, so a repo with no commits cannot host one. Refuse with a reason up
  // front instead of letting the run start in a tree that cannot exist.
  async function spawnBlocker(cwd, target) {
    if (target?.empty) {
      return `${target.name} has no commits yet (unborn HEAD), so a worktree cannot be created there — make an initial commit first.`;
    }
    const head = await gitIn(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], 15000);
    if (head.ok) return null;
    const err = String(head.err || head.out || "");
    if (/not a git repository/i.test(err)) return `${cwd} is not a git repository — an agent works in a worktree, which needs one.`;
    return `${cwd} has no commits yet (unborn HEAD), so a worktree cannot be created there — make an initial commit first.`;
  }

  // The git top level of a directory. `git rev-parse --show-toplevel` fails in a repository with no
  // commit, and a directory that is already the answer keeps it rather than becoming null.
  async function topLevel(cwd) {
    const top = await gitIn(cwd, ["rev-parse", "--show-toplevel"]);
    return top.ok && top.out ? top.out : cwd;
  }

  // The gateway is not a detail to find out after a card says "starting": a stopped gateway or a key
  // that went missing is the answer to "why did nothing happen". Returns the reason, or null when the
  // Runs API can be used.
  async function gatewayRefusal() {
    const transport = await jobs.probe();
    if (transport.reachable && transport.capabilities?.runs) return null;
    return `the Hermes gateway API is not usable at ${jobs.api.url}${transport.error ? `: ${transport.error}` : ""}`;
  }

  // The card's first three steps: which project this spawn is for, and which directory it is about.
  // The directory is the ground truth: a cwd inside a known project overrides a stale project picker,
  // so a spawn aimed at one worktree can never be checked, filed or cut against another project.
  // `project` is returned only when the typed one has to be corrected.
  function targetForSpawn(body = {}) {
    const pickerTarget = body.project ? findProject(body.project) : null;
    if (body.project && !pickerTarget) return { ok: false, error: `unknown project: ${body.project}` };
    const cwdProject = projectForPath(body.cwd);
    return {
      ok: true,
      project: cwdProject && body.project !== cwdProject.name ? cwdProject.name : undefined,
      cwdProject,
      target: cwdProject || pickerTarget,
    };
  }

  // The preview the confirm box draws: the exact request that would be sent, and the answer to "would
  // this even work", both before anything is promised. The thread name carries a random suffix, so the
  // preview shows its shape rather than a name the run will have.
  async function previewPayload(body = {}) {
    const target = body?.project ? findProject(body.project) : null;
    const cwd = body?.cwd || target?.path || getConfig().defaultCwd;
    const blocked = await spawnBlocker(cwd, target);
    const req0 = previewRequest({
      ...(body || {}),
      thread: makeThreadName(body?.prompt || ""),
      // A preview that hides the clarify hint is not a preview of what will be sent.
      clarifyInstruction: jobs.clarify?.instruction?.() || "",
    });
    return {
      transport: jobs.transportInfo(),
      request: req0,
      cwd,
      project: target?.name || null,
      blocked,
      command: `POST ${jobs.api.url}${req0.path}\n${JSON.stringify(req0.body, null, 1)}`,
    };
  }

  // The dry run the New-agent card asks for before it commits to anything: the same request, sent
  // nowhere. No gateway probe here on purpose — this is the shape of the request, not a promise.
  function dryRunPayload(body = {}, target = null) {
    const req0 = previewRequest({ ...body, clarifyInstruction: jobs.clarify?.instruction?.() || "" });
    return {
      dryRun: true,
      project: body.project || null,
      transport: jobs.transportInfo(),
      request: req0,
      cwd: body.cwd || target?.path || getConfig().defaultCwd,
      command: `POST ${jobs.api.url}${req0.path}\n${JSON.stringify(req0.body, null, 1)}`,
    };
  }

  // The rest of the card's procedure: the gateway, the tree a stale path really means, the unborn-HEAD
  // refusal, the owner path, and the one question the card must answer honestly — is this run going to
  // stay in the project's own checkout rather than a branch of its own? Returns either a refusal to
  // send, or the fields `jobs.create` wants.
  async function linkSpawn(body = {}, target = null, cwdProject = null) {
    const refused = await gatewayRefusal();
    if (refused) return { ok: false, status: 503, payload: { error: refused } };
    let cwd = body.cwd || target?.path || getConfig().defaultCwd;
    // "existing": run in a directory that is already there (a worktree you picked), so no
    // worktree is created and the agent's edits land directly in that tree.
    const existing = Boolean(body.existing);
    // A directory that is already there is still the first answer, but a missing one is no longer the end of
    // the request: the panel renames a finished run's worktree directory and its branch after the thread
    // title, so a path this card was holding can be one rename out of date while the tree stands. Resolved
    // against git's own worktree list — one match is used and named on the card, several list themselves,
    // none keeps the refusal this endpoint always gave.
    let picked = null;
    if (existing) {
      picked = await resolveExistingTarget({ target: cwd, project: cwdProject || target, projects: getProjects() });
      if (!picked.ok) return { ok: false, status: 400, payload: { error: picked.error, candidates: picked.candidates } };
      cwd = picked.path;
    }
    const blocked = await spawnBlocker(cwd, existing ? null : target);
    if (blocked) return { ok: false, status: 400, payload: { error: blocked, blocked } };
    // Attach to the worktree the spawn actually runs in, not to the directory that was typed: a cwd
    // inside `…/lib` is still the same worktree, and an owner path matching no row would show up as
    // unattached even though it is sitting in a tree we know.
    const ownerPath = existing ? await topLevel(cwd) : null;
    // A spawn that stays in the project's own checkout is not "an existing worktree": the card should
    // say so, because that is the difference between an agent working in a branch of its own and one
    // editing the tree the reader has checked out. A resolved tree can belong to a project the typed
    // directory never named (a branch is not a path).
    const home = (picked?.project ? findProject(picked.project) : null) || cwdProject || null;
    const baseCheckout = Boolean(existing && home && normPath(ownerPath || cwd) === normPath(home.path));
    const note = picked ? resolutionNote(picked) : "";
    // A run the reader marked "may land" (the spawn card's own toggle) is told WHICH remote and which base to land
    // on, so the brief's first line names the landing step instead of leaving a placeholder to guess at. Nothing
    // else changes: the panel still never pushes.
    const land = body.landing ? { remote: target?.remote || null, baseBranch: target?.mainBranch || null } : {};
    return {
      ok: true,
      fields: {
        cwd,
        existing,
        ownerPath,
        ownerPending: !existing,
        baseCheckout,
        ...land,
        // The card says which tree a stale path resolved to, not just that something ran.
        note: note ? `SPAWN IN ${note}` : null,
      },
    };
  }

  // Start a worker on the assistant's behalf. Deliberately the same mechanics as the New-agent card —
  // registry for the project, gateway probe before anything is promised, `git rev-parse`/`worktree add` in
  // lib/jobs.js — but with no dry run and no model field, so the worker runs on the gateway default rather
  // than on the small model the assistant itself uses.
  async function assistantSpawnRun(spec = {}) {
    const prompt = String(spec.prompt || "").trim();
    if (!prompt) throw new Error("a spawn needs a prompt");
    const refused = await gatewayRefusal();
    if (refused) throw new Error(refused);
    const target = spec.project ? findProject(spec.project) : projectForPath(spec.target);
    if (spec.existing) {
      // An agent in a directory that already exists: no tree is cut, and the card attaches to the git top level.
      // The directory named is not taken on trust any more: the panel renames a finished run's worktree directory
      // AND its branch after the thread title, so the path an assistant wrote down when it watched that worker
      // finish, or a reader typed from an older report, is one rename out of date while the tree stands. Resolve
      // it against git's own worktree list (lib/spawn-target.js) — one match is used and named on the card,
      // several are an error that lists them, none keeps the refusal this line always gave.
      const res = await resolveExistingTarget({
        target: spec.target || target?.path,
        // A path inside a project is that project's business; a branch or a bare worktree name carries no path to
        // place, so the registry is the search space.
        project: target,
        projects: getProjects(),
        thread: spec.thread || null,
      });
      if (!res.ok) throw new Error(res.error);
      const cwd = res.path;
      // The same refusal the New-agent card makes: a directory that is not a git repository, or is one
      // with no commits, cannot host a turn — the agent's first `git status` fails and the card says
      // "starting" while nothing can work. The verdict used to be measured here and thrown away, on the
      // assumption that lib/jobs.js's `create` refuses an unborn HEAD for whichever tree it is handed.
      // It does not: that guard sits inside the worktree-cutting branch (`!opts.existing`), and an
      // existing tree never goes near it. Measured, not reasoned: `git worktree list --porcelain`
      // answers in an unborn repo and lib/spawn-target.js resolves it, so a `SPAWN IN` on a repo with no
      // HEAD reached the next line and started a run. lib/assistant.js tells the reader the server
      // refuses this, so honouring it here is keeping a documented promise, not adding a refusal.
      const blocked = await spawnBlocker(cwd, null);
      if (blocked) throw new Error(blocked);
      const ownerPath = await topLevel(cwd);
      // A resolved tree can name a project the line itself never did (a branch is not a path), and that project is
      // what decides whether this run stays in the project's own checkout rather than a branch of its own.
      const home = target || findProject(res.project) || null;
      const note = resolutionNote(res);
      // Who asked for this run: the assistant's own SPAWN grammar by default, or whatever the caller names (the row's
      // ⟳ starts one to double-check its own reconciliation, and the card must say so rather than "started by the
      // assistant"). The `where` and any rename detail are the panel's to add, never the caller's.
      const origin = spec.origin && typeof spec.origin === "object" ? spec.origin : { kind: "assistant-spawn" };
      return jobs.create({
        prompt,
        cwd,
        existing: true,
        ownerPath,
        ownerPending: false,
        baseCheckout: Boolean(home && normPath(ownerPath) === normPath(home.path)),
        // The assistant's TODO lines for this card become the tree's list, in order, BEFORE the worker is handed it —
        // the same seeding lib/jobs.js does for a brief of its own, and the reason the ids the worker reads are the
        // ids of its own items.
        todoSeed: Array.isArray(spec.todos) ? spec.todos : [],
        // The card says which tree a stale name resolved to, not just that something ran.
        note: note ? `SPAWN IN ${note}` : null,
        origin: {
          ...origin,
          where: "existing",
          ...(res.resolved ? { resolvedFrom: res.asked, resolvedPath: res.path, resolvedHow: res.how } : {}),
        },
      });
    }
    if (!target) throw new Error(`unknown project: ${spec.target || spec.project || "(none)"}`);
    const blocked = await spawnBlocker(target.path, target);
    if (blocked) throw new Error(blocked);
    return jobs.create({
      prompt,
      cwd: target.path,
      project: target.name,
      existing: false,
      // The assistant's TODO lines for this card become the NEW tree's list, in order, before the worker is handed it.
      todoSeed: Array.isArray(spec.todos) ? spec.todos : [],
      // The worktree appears a moment later; adoptFromJob files the card under its own row when it does.
      ownerPending: true,
      origin: { kind: "assistant-spawn", project: target.name },
    });
  }

  return { assistantSpawnRun, dryRunPayload, gatewayRefusal, linkSpawn, previewPayload, projectForPath, targetForSpawn };
}
