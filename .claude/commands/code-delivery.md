---
description: Run the autonomous code-delivery pipeline — implement → review (loop) → refine → open PR — from the plan that /planification wrote. Refuses to start without a plan.
argument-hint: (no arguments — drives the plan for the current branch)
---

You are the orchestrator of the **code-delivery pipeline**: a sequential chain of
coding agents that takes the plan for this branch all the way to an open pull
request, with no further input. It is the companion to `/planification` — that
command writes the plan; this one delivers it.

```
preflight ─▶ IMPLEMENTER ─▶ ( REVIEWER ⇄ IMPLEMENTER ) ─▶ REFINER ─▶ PR-MANAGER
```

## Step 0 — Preflight & guard (REQUIRED — do this first)

The pipeline is driven by the plan file, computed deterministically (one plan per
worktree/branch — the same rule `/planification` uses):

```bash
leaf="$(git branch --show-current 2>/dev/null | sed 's#.*/##')"
[ -z "$leaf" ] && leaf="plan"
echo "tmp/plans/${leaf}.md"
```

**If that file does not exist, STOP.** Do not implement, do not branch, do not
open anything. Tell the user there is no plan for this branch and to run
`/planification` first. The pipeline must not start without a plan. It also needs
a real branch (a PR needs one), so it refuses to start on a detached HEAD.

## How to run it

The pipeline is a self-contained Workflow at
[`.claude/workflows/code-delivery.js`](../workflows/code-delivery.js). Once the
plan exists, launch it as a single autonomous run:

> Use the **Workflow** tool: `Workflow({ name: "code-delivery" })`.

The Workflow re-runs the preflight guard itself (so it will refuse to start if the
plan is missing), then runs every stage to completion — looping REVIEWER ⇄
IMPLEMENTER until the work passes review, refining, and opening the PR. Relay its
final result (review status, iterations, PR URL, CI status) to the user.

If the Workflow tool is unavailable, execute the four stages sequentially in this
conversation instead, using the adapted prompts in the workflow file: spawn the
IMPLEMENTER, then the REVIEWER; on a `NEEDS_WORK` verdict loop back to the
IMPLEMENTER (up to `MAX_REVIEW_ITERATIONS`); on `READY` run the REFINER, then the
PR-MANAGER. Stop and report on `BLOCKED` or if the loop cap is hit — do not open a
PR on work that has not passed review.

## The stages (prompts adapted from `reference/server/constants/prompts/`)

| Stage | Adapted from | What it does | Key adaptations |
|---|---|---|---|
| **IMPLEMENTER** | `implementation.md` (+ `yolo.md` ph. 2) | Implements every unchecked To-Do item, marks them `[x]`, commits on the branch. On a loop-back it reads `## Review Findings` and fixes the un-checked items first. | Targets the plan file; commits explicitly; no task-id / DB. |
| **REVIEWER** | `review.md` | Strict checklist verification, unit tests, then the plan's mandatory QA scenarios — **run hands-on, incl. live model conversations** (dev server + Playwright MCP); writes `## Review Findings` to the plan and returns `READY` / `NEEDS_WORK` / `BLOCKED`. | Findings written to the plan file; **no** `complete-workflow.ts` / `block-workflow.ts`; verdict drives the loop instead. |
| **REFINER** | `refinement.md` | Parallel code-simplification + security review (OWASP, confidence ≥ 8), then applies security fixes and commits. | Standalone; no task-doc edits, no completion scripts. |
| **PR-MANAGER** | `pr.md` | Pushes the branch, opens the PR with a summary of the plan + changes + review/QA + refinement results, and drives CI to green. Never merges. | No `complete-pr.ts`; summary folds in the live review/refine results. |

## QA is hands-on — including live model conversations

The REVIEWER's QA is not a paper exercise. Validating a feature very often means
**engaging a real, live model**: start a dev server on a free port from this
worktree and use **Playwright MCP** to open a conversation and send a live query
to the model/agent, then watch the real result. That is completely normal and
expected — it spins up a dev server, consumes model quota, and creates real
conversations, and that is fine. Do it whenever it is the honest way to confirm
the work (and budget for the wait — a live run can take several minutes).

`BLOCKED` is a **high bar**, reserved for a genuine external wall (a missing
credential, a third-party system you cannot reach, a decision only the user can
make). Needing a live model run, a dev server, model quota, or "the
canonical/production box" does **not** count — attempt it first. If the dev
server's transport looks broken, suspect your own port/config wiring before
concluding the feature is untestable.

## Guarantees

- **No plan ⇒ no start.** Both this command and the Workflow guard on the plan file.
- **Autonomous.** No clarifying questions; reasonable assumptions are stated in commits/PR.
- **Branch-scoped.** All work stays on the current branch and worktree; the user merges the PR manually.
