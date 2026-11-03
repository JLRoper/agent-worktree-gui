# Working the queue — an assessment from Assistant #2

Written 3 November 2026, at the end of a long session on the agent-worktree-gui panel.
This is about the task queue itself, not about the projects: what it carried well, where it
misled me, and what I would change. Every number below was measured during the session.

## Scale of the session

Seventy-three rows closed, seven parked, two queued. Four repositories were worked at once:
agent-worktree-gui, ai-development-factory, ai-pipeline-factory and sales-citdev-POC. Roughly
thirty workers were started, of which five were killed by two panel restarts, three died on a
clarify call, two SPAWN lines produced no job at all, and one produced a commit and then parked
itself forever. Everything that mattered still landed.

## What works

**The row survives what the workers do not.** Two panel restarts killed five runs mid-flight, and
three separate workers died on the clarify trap. Not one task was lost, because the row held the
state and the reason field held the evidence. A worker is ephemeral; the row is the memory.

**Parking with a written reason is the single most valuable habit.** Seven rows are parked tonight,
each naming a real blocker rather than a mood. Two of them — the task window and the per-task
pipeline — went stale the moment PR #286 merged, and the panel's own stale-reason marker caught
that without me looking.

**The reason field became an evidence ledger.** When a row closes I write what I verified: blob
hashes equal on both sides, line counts, citation counts, which suite was red before and why. That
turned "the worker says it landed" into something a later wake can audit, and it caught two cases
where the worker's summary was tidier than the truth.

**Naming the row on a SPAWN pays for itself.** The panel writes the thread and tree onto the row at
the cut, so when a worker dies I can tell which row it was carrying and whether it left a commit
behind. Twice that was the difference between re-issuing work and landing a commit from a run that
looked dead.

**Parallelism across repositories is real.** Three Sales POC documents, a semantic layer, two HTML
pages and a standards catalogue were built side by side because the rows made the ownership clear
and the trees never overlapped.

## What does not work

**The queue has no dependency graph, so parking is prose.** Row #79 waits on three documents, but
nothing on the row knows that; the dependency lives in a sentence. When one of those documents
landed in a different repository, put there by a different assistant, nothing re-evaluated the
park. Parked reasons rot silently unless a human reads them.

**Two assistants can file the same job, and both run.** The technology specification exists twice
with different bodies, 312 lines in the factory and 434 in the project repo. The module API layer
exists twice too, 1,209 lines against 1,364. Both pairs were authored by two parallel worker sets
that never knew about each other. The queue has no dedupe key and no claim step, so the cost was
paid twice and the reader now has to choose.

**The state words lie at the edges.** At any moment tonight there were five to seven rows reading
running with no live job behind them. And "PR MERGED" means three different things in three
repositories: a real GitHub merge in agent-worktree-gui, a local --no-ff merge on main in the two
factories, and a local merge in sales-citdev-POC which has no remote at all. My own rule — mark a
row done only when its PR reads MERGED — had to be reinterpreted per repository, which is exactly
the kind of drift a rule is supposed to prevent.

**A SPAWN line can vanish with no error.** Twice tonight a long brief produced no job at all and
left the row queued. Nothing alerted. I found it by reading /api/jobs and noticing a thread that
should exist did not. The same task re-issued in four short TODOs started within seconds both
times, which is now a standing rule, but a rule about how I write briefs is a poor substitute for
a tool that reports a dropped spawn.

**Effort is invisible, so I cannot plan.** Row #94, the semantic layer, took twenty minutes and
produced 3,068 lines of cited data. Row #32, wiring DSL gaps, took fifty-three. Nothing on either
row said which it would be, so the only way to know is to have done it.

**Done rows pile up and the digest truncates.** Seventy-three closed rows mean the useful ones are
buried, and the digest shows only the top of the list. The truth about what happened tonight lives
in my scratchpad and in the reason fields, not in the shape of the queue.

## What I would change in the queue itself

**A declared dependency field.** dependsOn: [ids], so parking is a fact rather than a sentence, and
the panel can wake me when the last dependency closes. This is the change I would make first.

**A dedupe or claim key.** Repository plus intent, so a second assistant filing the same document
gets told it is already carried, instead of both of us paying for it. Failing that, a claim button
that marks the row owned.

**A verified block on the row.** Commit SHA, the commands run, their results. Done should carry its
own proof, not point at a reason sentence I wrote at midnight.

**Stale as a first-class state.** The panel already computes it. Make it a state I can filter, and
stop counting a row with no live job as running.

**Three kinds of done.** Landed, superseded by someone else's work, and abandoned because the
premise was refuted. Tonight had all three: #86 and #88 were superseded by a sibling run, and #35
was refuted by earlier work. Calling all of them done is the least honest thing the queue does.

**A digest that orders by change since the last wake**, not by position. What matters on waking is
what moved while I was asleep.

## Method note

The numbers here come from this session: git in four repositories, /api/jobs for run state, and the
queue's own rows. Where I could not verify something I have said so rather than smoothing it.
