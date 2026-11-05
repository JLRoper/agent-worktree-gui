// The one definition both demo pages draw: the real seven-stage `sefl-review-loop` from pipelines.seed.json.
//
// Nothing here is invented except the edge named in `loops` below. The stages, their titles, their prompts and
// their exit checks are copied verbatim out of pipelines.seed.json; the 13-stage `wide` view is copied out of
// pipeline-bundle.seed.json (S0-S12, their written artifacts, the five gates that follow a stage, the three loop
// handoffs) so a demo can prove the drawing holds at the top of the range the panel promises, not only at seven.
//
// A DEFINITION CARRIES NO LOOP. `sefl-review-loop`'s `next` is null and its stages end on exit checks; the loop
// the flow really makes is the review round trip — a reviewer asks for changes, the work is answered, the head is
// reviewed again — and no field in the definition says so. It is drawn here as ONE dashed edge from `approve`
// back to `address`, labelled with what the round trip is, so both demos exercise the arc the brief asks about.
// A bundle does carry loops (kind: "loop", with a cap); `wide.loops` are those, unedited.
window.PIPELINE_DEMO = {
  "def": {
    "id": "sefl-review-loop",
    "title": "SEFL review loop",
    "kind": "turnover",
    "description": "Cut a correctly named turnover branch, open a PR for code_review_java, answer what arrives, merge when approved.",
    "stages": [
      {
        "id": "branch",
        "title": "Name the branch",
        "prompt": "Rename this tree's branch to YYYYMMDD_HHMM_<TICKET>_<desc> and nothing else: the cut's own local time, the ticket id the work names ({{ticket}}), and <desc> as lowercase words joined by underscores. Example: 20261102_1431_ABC-1234_fix_login_redirect. Then report the new name.",
        "gate": {
          "check": "branch-name",
          "params": {
            "pattern": "^\\d{8}_\\d{4}_[A-Z][A-Z0-9]+-\\d+_[a-z0-9._-]+$",
            "branch": "{{branch}}"
          }
        }
      },
      {
        "id": "push",
        "title": "Push the branch",
        "prompt": "Push the branch, never {{main}}: git push origin {{branch}}. If the push is refused, report the refusal and stop — the panel's permission box is the only thing that grants a write.",
        "gate": {
          "check": "pushed",
          "params": {}
        }
      },
      {
        "id": "pr",
        "title": "Open the pull request",
        "prompt": "Open ONE pull request from {{branch}} into {{main}} on the project's {{host}}, following the landing doctrine exactly:\n\n- title: \"Java Code Review for <repo> <branch>\"\n- reviewers: the GROUP code_review_java and nothing else — no individuals, no DAL group on a non-DAL change\n- description, four sections, every one present: ## Jira Ticket, ## Description, ## Test Procedures, ## Technical Specifications\n\nPOST it to the host's pull-request endpoint with the landing doctrine's REST path and bearer token, fromRef refs/heads/{{branch}}, toRef refs/heads/{{main}}. Read the PR back: reviewers must be exactly [code_review_java], and fromRef.latestCommit must be the head you pushed. Report the PR id and URL.",
        "gate": {
          "check": "pr-open",
          "params": {}
        }
      },
      {
        "id": "wait",
        "title": "Wait for the reviewer",
        "prompt": "Read the PR's activities once (the landing doctrine names the endpoint). Report what arrived, then END the turn: say plainly that nothing has arrived if nothing has. Do not sleep, do not poll in a loop, and do not merge — the panel re-checks on its own clock and wakes this thread when there is something to answer.",
        "gate": {
          "check": "pr-comments",
          "params": {}
        }
      },
      {
        "id": "address",
        "title": "Answer the review",
        "prompt": "For each new comment on the PR for {{branch}}: make the smallest change that answers it, commit on {{branch}}, push, and reply on that comment naming the commit. Then report what you answered. An approval at an older commit is not an approval of the head — after any push the head needs re-approval.",
        "gate": {
          "check": "pushed",
          "params": {}
        }
      },
      {
        "id": "approve",
        "title": "Wait for the approval at the head",
        "prompt": "Nothing to say: wait for the head to be reviewed. The stage ends when an approval exists whose lastReviewedCommit equals the PR's current head ({{sha}}). Report the reviewer and the commit they approved.",
        "gate": {
          "check": "pr-approved",
          "params": {}
        }
      },
      {
        "id": "merge",
        "title": "Merge",
        "prompt": "Merge the PR for {{branch}} with its current version: POST the host's merge endpoint (the landing doctrine names it) with the PR id and ?version=<the PR's current version>. Then confirm {{main}} moved. Never push {{main}} directly and never decline or close the PR.",
        "gate": {
          "check": "pr-merged",
          "params": {}
        }
      }
    ]
  },
  "loops": [
    {
      "id": "H-review",
      "from": "approve",
      "to": "address",
      "label": "another review round"
    }
  ],
  "wide": {
    "id": "poc-to-uat",
    "title": "POC to UAT",
    "stages": [
      {
        "id": "S0",
        "title": "S0",
        "artifact": "charter",
        "gate": {
          "check": "Charter"
        }
      },
      {
        "id": "S1",
        "title": "S1",
        "artifact": "change-log",
        "gate": {
          "check": "Behaviour"
        }
      },
      {
        "id": "S2",
        "title": "S2",
        "artifact": "frozen-export",
        "gate": {
          "check": null
        }
      },
      {
        "id": "S3",
        "title": "S3",
        "artifact": "semantic-layer",
        "gate": {
          "check": "Meaning"
        }
      },
      {
        "id": "S4",
        "title": "S4",
        "artifact": "module-plan",
        "gate": {
          "check": null
        }
      },
      {
        "id": "S5",
        "title": "S5",
        "artifact": "skeleton",
        "gate": {
          "check": null
        }
      },
      {
        "id": "S6",
        "title": "S6",
        "artifact": "module-build",
        "gate": {
          "check": null
        }
      },
      {
        "id": "S7",
        "title": "S7",
        "artifact": "dal-verdict",
        "gate": {
          "check": null
        }
      },
      {
        "id": "S8",
        "title": "S8",
        "artifact": "finding-set",
        "gate": {
          "check": null
        }
      },
      {
        "id": "S9",
        "title": "S9",
        "artifact": "verdict",
        "gate": {
          "check": null
        }
      },
      {
        "id": "S10",
        "title": "S10",
        "artifact": "parity-report",
        "gate": {
          "check": "Rebuild"
        }
      },
      {
        "id": "S11",
        "title": "S11",
        "artifact": "install-verdict",
        "gate": {
          "check": null
        }
      },
      {
        "id": "S12",
        "title": "S12",
        "artifact": "signed-dod",
        "gate": {
          "check": "UAT sign-off"
        }
      }
    ],
    "loops": [
      {
        "id": "H-10",
        "from": "S9",
        "to": "S8",
        "label": "3 rounds (P-50)"
      },
      {
        "id": "H-12",
        "from": "S10",
        "to": "S9",
        "label": "3 rounds (P-50)"
      },
      {
        "id": "H-15",
        "from": "S12",
        "to": "S11",
        "label": "2 re-deliveries"
      }
    ]
  }
};
