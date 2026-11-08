// The ladder definitions the renderer tests are driven against.
//
// WHY THIS FILE EXISTS. pipelines.seed.json used to ship seven ladder definitions and the renderer tests read
// them from there. Every pipeline this board ships is a PDL document now (pipeline-bundle.seed.json), and the
// ladder seed ships `pipelines: []` — but the ladder renderer is still part of the product: a reader may write
// their own definition into pipelines.json, and the Settings tab still edits it. So the shapes the tests are
// pinned against live here, copied verbatim from the seed as it shipped, rather than being deleted with the seed
// or re-derived from a PDL document that has no `exit` to draw.
//
// `local` is the one-stage shape, `investigate` the two-stage one that ends on a file, `turnover` the three-stage
// one with an exit on every stage, and `sefl-review-loop` the seven-stage one whose round trip is iterative in its
// prompts only.
export const LADDER_DEFINITIONS = [
  {
    "id": "local",
    "kind": "local",
    "title": "Local work",
    "description": "Work in this tree and stop. The LANDING paragraph composed into the prompt decides whether that includes a push and a pull request.",
    "stages": [
      {
        "id": "work",
        "title": "Work in this tree",
        "prompt": "Do the work in this tree and stop there. {{desc}}\n\nCommit what you changed in one revertable commit on {{branch}}, then report what you did: the files you touched, the commands you ran and their real results. Where this prompt carries a LANDING paragraph, that paragraph is the only instruction about pushing and opening a pull request: follow it exactly.",
        "exit": {
          "check": "commits",
          "min": 1
        }
      }
    ],
    "next": null
  },
  {
    "id": "investigate",
    "kind": "investigation",
    "title": "Investigation",
    "description": "Find out something and write it down, in this tree. Ends by concluding.",
    "stages": [
      {
        "id": "probe",
        "title": "Probe",
        "prompt": "Find out what is actually being asked: {{desc}}\n\nRead, run and probe in this tree. Record what you ran and what it really returned — the capture, the script, the artefact. Commit the evidence on {{branch}} in one revertable commit. Do not push {{main}} and do not open a pull request.",
        "exit": {
          "check": "commits",
          "min": 1
        }
      },
      {
        "id": "conclude",
        "title": "Conclude",
        "prompt": "Write the conclusion down in docs/investigation.md: what you found, what you ruled out, and what should happen next. Commit it on {{branch}} and report it in a few lines. Do not push.",
        "exit": {
          "check": "file-exists",
          "path": "docs/investigation.md"
        }
      }
    ],
    "next": null
  },
  {
    "id": "turnover",
    "kind": "turnover",
    "title": "Turnover",
    "description": "This work is going to land: commit, push the branch and open the pull request, following this host's landing doctrine.",
    "stages": [
      {
        "id": "commit",
        "title": "Commit",
        "prompt": "Commit everything in this tree on {{branch}} in one revertable commit whose subject names the symptom. {{desc}}\n\nDo not push yet.",
        "exit": {
          "check": "commits",
          "min": 1
        }
      },
      {
        "id": "push",
        "title": "Push the branch",
        "prompt": "Push the branch, never {{main}}: git push -u origin {{branch}}. If the write is refused, report the refusal and stop — the panel's permission box is the only thing that can grant it.",
        "exit": {
          "check": "pushed"
        }
      },
      {
        "id": "pr",
        "title": "Open the pull request",
        "prompt": "Open ONE pull request from {{branch}} into {{main}}, following this project's landing doctrine — the host is {{host}}, and the doctrine names the title, the reviewers and the description sections. Report the PR URL. Leave it open: this definition does not merge.",
        "exit": {
          "check": "pr-open"
        }
      }
    ],
    "next": null
  },
  {
    "id": "sefl-review-loop",
    "kind": "turnover",
    "title": "SEFL review loop",
    "description": "Cut a correctly named turnover branch, open a PR for code_review_java, answer what arrives, merge when approved.",
    "stages": [
      {
        "id": "branch",
        "title": "Name the branch",
        "prompt": "Rename this tree's branch to YYYYMMDD_HHMM_<TICKET>_<desc> and nothing else: the cut's own local time, the ticket id the work names ({{ticket}}), and <desc> as lowercase words joined by underscores. Example: 20261102_1431_ABC-1234_fix_login_redirect. Then report the new name.",
        "exit": {
          "check": "branch-name",
          "pattern": "^\\d{8}_\\d{4}_[A-Z][A-Z0-9]+-\\d+_[a-z0-9._-]+$",
          "branch": "{{branch}}"
        }
      },
      {
        "id": "push",
        "title": "Push the branch",
        "prompt": "Push the branch, never {{main}}: git push origin {{branch}}. If the push is refused, report the refusal and stop — the panel's permission box is the only thing that grants a write.",
        "exit": {
          "check": "pushed"
        }
      },
      {
        "id": "pr",
        "title": "Open the pull request",
        "prompt": "Open ONE pull request from {{branch}} into {{main}} on the project's {{host}}, following the landing doctrine exactly:\n\n- title: \"Java Code Review for <repo> <branch>\"\n- reviewers: the GROUP code_review_java and nothing else — no individuals, no DAL group on a non-DAL change\n- description, four sections, every one present: ## Jira Ticket, ## Description, ## Test Procedures, ## Technical Specifications\n\nPOST it to the host's pull-request endpoint with the landing doctrine's REST path and bearer token, fromRef refs/heads/{{branch}}, toRef refs/heads/{{main}}. Read the PR back: reviewers must be exactly [code_review_java], and fromRef.latestCommit must be the head you pushed. Report the PR id and URL.",
        "exit": {
          "check": "pr-open"
        }
      },
      {
        "id": "wait",
        "title": "Wait for the reviewer",
        "prompt": "Read the PR's activities once (the landing doctrine names the endpoint). Report what arrived, then END the turn: say plainly that nothing has arrived if nothing has. Do not sleep, do not poll in a loop, and do not merge — the panel re-checks on its own clock and wakes this thread when there is something to answer.",
        "exit": {
          "check": "pr-comments"
        }
      },
      {
        "id": "address",
        "title": "Answer the review",
        "prompt": "For each new comment on the PR for {{branch}}: make the smallest change that answers it, commit on {{branch}}, push, and reply on that comment naming the commit. Then report what you answered. An approval at an older commit is not an approval of the head — after any push the head needs re-approval.",
        "exit": {
          "check": "pushed"
        }
      },
      {
        "id": "approve",
        "title": "Wait for the approval at the head",
        "prompt": "Nothing to say: wait for the head to be reviewed. The stage ends when an approval exists whose lastReviewedCommit equals the PR's current head ({{sha}}). Report the reviewer and the commit they approved.",
        "exit": {
          "check": "pr-approved"
        }
      },
      {
        "id": "merge",
        "title": "Merge",
        "prompt": "Merge the PR for {{branch}} with its current version: POST the host's merge endpoint (the landing doctrine names it) with the PR id and ?version=<the PR's current version>. Then confirm {{main}} moved. Never push {{main}} directly and never decline or close the PR.",
        "exit": {
          "check": "pr-merged"
        }
      }
    ],
    "next": null
  }
];

export const ladderDefinition = (id) => JSON.parse(JSON.stringify(LADDER_DEFINITIONS.find((p) => p.id === id)));
