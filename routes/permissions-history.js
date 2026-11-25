// The header's Permissions popup, one read: every permission request this panel has held, newest first, with the
// live ones the popup may answer and the honest total beside the page of rows. The store is
// lib/permissions-history.js and the live queue is lib/approvals.js; this adapter owns only the wire shape.
//
//   GET /api/permissions/history?limit=50
//     -> { at, entries, pending, total, outstanding, kept, cap }
//
// `entries` is the store's own records: one per request, open, answered or expired, with the exact request text, the
// choices the host allowed, the run and thread the request belongs to, the choice a person pressed (or the reason it
// expired), and when each of those happened. `pending` is the requests the panel can answer RIGHT NOW - the live
// Approvals queue, filtered to those whose window has not closed - decorated with the same names as the rows, so the
// popup's answer control and the history it draws agree about one request.
//
// `outstanding` is the header button's count: the number of live requests, never the number of stored rows. A request
// past its deadline is not counted even while the Approvals sweep has not yet removed it (the sweep runs every 5 s),
// because the gateway has already denied it and a button offering it would send the reader to a refusal.
//
// `limit` is the RENDER cap the page asks for, never a filter on the total: `total` always counts what the store
// holds, so "showing 50 of 137" cannot become a silent truncation. With no limit every kept row is returned (the
// store's own PERMISSIONS_HISTORY_KEEP is the only bound).
//
// The read is deliberately outside the state snapshot, exactly like the Clarify history: the snapshot is polled every
// tick by every open page and this list changes only when a request arrives or ends, so the popup fetches it when it
// opens (and on a slow tick while it is open) rather than making every board poll carry a growing list.
//
// A ROW IS SETTLED HERE WHERE THE PROCESS CAN PROVE IT. An open row whose request is no longer in the live queue is
// expired by this read (a deadline that passed reads "timed out", anything else reads "the gateway no longer holds
// it"), which is what makes the list honest after a panel restart: the store survives, and a request the restarted
// process cannot answer stops looking answerable. This route NEVER answers a request: the only answer path is
// POST /api/approvals/answer, pressed by a person.

/** The one path this prefix answers, and the row the mount table in server.js matches on. */
export const PERMISSIONS_HISTORY_PATH = "/api/permissions/history";

const oneLine = (s, n = 400) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function createPermissionsHistoryRoutes({
  approvals,
  permissions,
  describe = null,
  nameForAssistant = null,
  sendJson,
  now = () => Date.now(),
} = {}) {
  if (!permissions) throw new Error("createPermissionsHistoryRoutes needs the PermissionsHistory store");
  if (typeof sendJson !== "function") throw new Error("createPermissionsHistoryRoutes needs sendJson from the server's transport");
  const where = typeof describe === "function" ? describe : () => ({});
  const nameFor = typeof nameForAssistant === "function" ? nameForAssistant : () => null;

  return async function permissionsHistoryRoutes(req, res, route, url) {
    if (route !== PERMISSIONS_HISTORY_PATH) return false;
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "only GET" });
      return true;
    }
    const params = url?.searchParams || new URL(req.url || "/", "http://127.0.0.1").searchParams;
    const raw = Number(params.get("limit"));
    const limit = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
    const clock = Number(now()) || Date.now();

    // The live queue, and only what can still be answered. A request whose window has closed is not live even while
    // the sweep has not run yet: the gateway denies at that instant, so offering it would be offering a refusal.
    let live = [];
    try {
      live = typeof approvals?.list === "function" ? approvals.list() : [];
    } catch {
      live = [];
    }
    const openIds = new Set();
    const liveRows = [];
    for (const r of Array.isArray(live) ? live : []) {
      const id = String(r?.id || "").trim();
      if (!id) continue;
      const deadline = Number(r.deadline) || 0;
      if (deadline && clock >= deadline) continue;
      openIds.add(id);
      const stored = permissions.find(id) || null;
      const who = where(String(r.thread || stored?.thread || ""));
      const row = {
        id,
        requestId: id,
        command: String(r.command ?? stored?.command ?? ""),
        policy: oneLine(r.description || r.policy || stored?.policy || "", 240),
        patternKey: String(r.patternKey || stored?.patternKey || ""),
        choices: (Array.isArray(r.allowed) && r.allowed.length ? r.allowed : stored?.choices || ["once", "deny"]).map((c) => String(c)),
        timeoutSeconds: Number(r.timeoutSeconds) || stored?.timeoutSeconds || null,
        deadline: deadline || stored?.deadline || null,
        receivedAt: r.receivedAt || stored?.askedAt || null,
        surface: String(r.surface || stored?.surface || ""),
        thread: String(r.thread || stored?.thread || "") || null,
        agent: oneLine(stored?.agent || who.agent || r.thread || r.surface || "an agent", 120),
        jobId: stored?.jobId || who.jobId || null,
        runId: stored?.runId || who.runId || null,
        tree: stored?.tree || who.tree || "",
        treePath: stored?.treePath || who.treePath || "",
        project: stored?.project || who.project || "",
        assistantId: stored?.assistantId || who.assistantId || null,
        assistantName: stored?.assistantName || who.assistantName || "",
      };
      const assistantId = row.assistantId ? String(row.assistantId) : null;
      const current = assistantId ? nameFor(assistantId) : null;
      if (current) row.assistantName = String(current);
      liveRows.push(row);
    }

    // Settle what the process can prove: an open row with no live request behind it. This is also the restart path -
    // a restarted panel holds nothing, so a request from before it reads expired rather than answerable.
    permissions.reconcile(openIds, { at: clock });

    const out = permissions.list({ limit });
    const rename = (row) => {
      const id = row.assistantId ? String(row.assistantId) : null;
      const current = id ? nameFor(id) : null;
      return current && current !== row.assistantName ? { ...row, assistantName: String(current) } : row;
    };
    liveRows.sort((a, b) => (Number(a.deadline) || Infinity) - (Number(b.deadline) || Infinity));
    sendJson(res, 200, {
      at: new Date(clock).toISOString(),
      entries: out.entries.map(rename),
      pending: liveRows,
      total: out.total,
      outstanding: liveRows.length,
      kept: out.kept,
      cap: out.cap,
    });
    return true;
  };
}
