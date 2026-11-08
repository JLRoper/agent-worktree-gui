# One job, one tree: what a cut does when the task is already in hand

A `SPAWN` line names a job, not a directory. Until this rule the panel answered every one of them the same way -
cut a worktree - so a job that was already in hand got a second tree, a second branch and a second card, and
neither card could see the other. Measured on this board: `convert-built-in-ladder-pipelines-to-pdl-f76189` and
`convert-all-seven-built-efe600` were two trees for one job.

Two changes, one rule each.

## 1. The cut reuses an unfinished tree whose task overlaps

Before `jobs.create` makes a tree, `lib/features/spawn.js` asks `lib/spawn-reuse.js` whether the project already
holds the tree this job belongs in. The answer is a recommendation, and the cut only takes it under three
conditions:

- **the same project** - a tree of another project is another job;
- **unfinished** - its branch is not the project's main, the board does not read it as `MERGED`, and it is
  either ahead of main, dirty, or has a run standing in it. A tree whose work already landed is a tree to sweep,
  not a place for the next job;
- **the same task** - at least three shared meaningful words and at least 60% of the smaller task's words
  (`lib/spawn-reuse.js`, `REUSE_MIN_SHARED` / `REUSE_MIN_SCORE`). The tree's task text is its own name - which is
  the task's words, see below - plus the prompts of the runs that stood in it, so a tree cut before this rule
  existed still overlaps on its run's prompt.

When all three hold, the run starts in that tree (`existing: true`) and the card says which tree it reused and
the words that tied them:

    reused the unfinished tree <path> (<branch>) instead of cutting a second one - its branch is unmerged
    and it already carries this task (convert, built, ladder, pipeline, pdl)

**A `SPAWN IN` the caller wrote is never overridden.** The rule only answers the question a plain `SPAWN` asks:
which tree should this job run in.

**A tree a live run holds is never shared.** One worker per tree is enforced in `lib/jobs.js`, so a held tree is
reported rather than used: a second tree is cut, and the card says so, naming the tree it would have reused and
why it could not:

    a second tree was cut: <path> (<branch>) already carries this task (its branch is unmerged, 1 commit ahead)
    and reuse was possible, but a run is live in that tree - one worker per tree

The note is pushed onto the card as a console line (`lib/jobs.js` `opts.note`) and the origin record carries
`reused` or `reuseBlocked`, so the fact survives a reload with the rest of the card.

A spawner built without rows - a tool, a unit test - has nothing to compare against and cuts exactly as before.

## 2. A freshly cut tree is named after the task's title, in whole words

`lib/tree-slug.js` gives the cut its name. The title is the prompt's first sentence (the line a reader would put
on a card), and the slug is cut BETWEEN words at 40 characters:

| prompt | tree |
|---|---|
| `Convert built-in ladder pipelines to PDL. Then convert the rest.` | `convert-built-in-ladder-pipelines-to-pdl-<tag>` |
| `Convert all seven built-in ladder pipelines to PDL` | `convert-all-seven-built-in-ladder-<tag>` |

The old cut took the first 24 characters of the prompt and cut inside a word; the rename took 40 and also cut
inside one. So one job could be spelled `convert-all-seven-built-efe600` by the cut and
`convert-built-in-ladder-pipelines-to-pdl-f76189` by the rename - two rules, two spellings, and neither joinable
to the other. The rename path (`server.js` `worktreeDirName`) now uses the same function, so a tree cut for a
task and a tree renamed after it are spelled the same way.

A caller holding a better title - a queue row's own words - passes `title` to `jobs.makeWorktree` or
`jobs.create`, and that is the name the tree gets.

## The proof

`test/spawn-reuse.test.js` drives the real spawner into a real `git worktree` and a stub gateway:

1. a second `SPAWN` naming an overlapping task runs in the first tree - one directory under `.worktrees`, the
   run posted into that directory, and the card saying it was reused;
2. the same second `SPAWN` with a live run holding that tree cuts its own tree and the card says reuse was possible,
   naming the tree;
3. a cut from a task title is named in whole words, and two tasks for one job get two readable, different names.

On the parent commit the first two fail exactly as the bug did (`existing` false, no note on the card), which is
the red half of the record.
