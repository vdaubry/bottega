# Core — The execution loop

The autonomous heart of the pipeline: an **implementation** agent does the work
from the plan, a **review** agent independently verifies it, and they alternate
until the work is verified ready — or the loop hits something only a human can
resolve. No person acts in between.

## What it delivers

> Once I approve the plan, two agents take turns: one writes the code and checks
> off the plan's to-do items, the other independently checks the work against
> the plan and runs the tests. If the reviewer finds gaps, it sends the work
> back; if it's satisfied, it releases the task to the PR step. I don't touch
> anything unless they get stuck.

## The shared scratchpad: the task doc

The two agents are separate, stateless turns — they don't share memory. They
coordinate **entirely through the task doc**. That one file carries:

- the plan's **To-Do List** (`Implementation` + `Testing` checkboxes), and
- a **Review Findings** section the review agent writes and the implementation
  agent reads.

This is the whole protocol: implementation checks items off and addresses
findings; review verifies checked items and rewrites the findings. State lives
in the document, not in either agent's context.

## The implementation agent

- Reads the task doc. **If a Review Findings section exists, address those
  issues first** — they're feedback from the previous review pass.
- Implements the **unchecked** to-do items in the worktree, marking each `[x]`
  as it finishes.
- **Does not ask questions** — it proceeds autonomously. Ambiguity was meant to
  be resolved at planning time.
- **Cannot delegate to sub-agents.** The Agent/sub-agent tool is disallowed for
  this agent so all work stays in one observable conversation rather than
  vanishing into an opaque, hours-long sub-agent. See the `disallowedTools` set
  in [`reference/server/services/agentRunner.ts`](../reference/server/services/agentRunner.ts).
- Ends its turn with **no completion script**. Completion is implicit, so the
  loop chains straight to review.

## The review agent

Independent quality assurance. Its prompt is deliberately skeptical —
implementation agents tend to mark things done when the work is partial, so the
reviewer's job is to catch that.

- **Early return.** If *any* to-do item is still unchecked, the implementation
  isn't finished. Write Review Findings = `IN_PROGRESS` listing the remaining
  items, stop, and return control to implementation. Don't review half-done
  work or run tests yet.
- **Full review (all items checked).** Verify **every** checked item against the
  plan with **strict matching** — "plan said create file X" means file X must
  exist with that content; an item checked but not actually done is a critical
  finding. Then run the tests: targeted unit tests first, then the full suite
  (long suites run in the background), then the manual scenarios from the
  Testing Strategy.
- **Verdict** — exactly one of:
  - **READY** — all items verified, all tests pass → run the completion script
    that sets `workflow_complete`. The loop then enters the finish pipeline
    (→ PR).
  - **NEEDS_WORK** — any verification or test failed → rewrite Review Findings
    with the specific issues, **uncheck the failed to-do items** (so
    implementation retries them), and end with no script. The loop chains back
    to implementation.
  - **BLOCKED** — all agent-doable work is done but remaining items physically
    require a human (a decision, external infra, credentials) → run the script
    that sets `workflow_blocked`. The loop stops until a human resumes.
- Review **only documents and decides — it never fixes code.**
- It **replaces** the Review Findings section every time (no history kept).

## How the loop reads all this

The transitions live in [`orchestration-loop.md`](./orchestration-loop.md); in
brief: implementation → review, review → implementation, with two diversions
that the loop checks **before** that toggle —

- `workflow_complete` set (review said READY) → finish pipeline → PR;
- `workflow_blocked` set (review said BLOCKED) → stop;
- and the iteration cap auto-blocks a runaway loop.

So a NEEDS_WORK review (which sets no flag) simply falls through to the toggle
and bounces back to implementation.

## Why two agents

Separation of powers. The implementer is biased toward declaring victory; an
independent reviewer with a skeptical prompt and strict matching catches partial
or skipped work. Crucially, the verdict is expressed as **edits to the task doc
plus a flag** — never as prose the orchestrator has to interpret. That is what
keeps the loop dumb and reliable (see
[`orchestration-loop.md`](./orchestration-loop.md)).

## What to build

- [ ] The implementation prompt: address findings → implement unchecked items →
      check them off → never ask questions.
- [ ] Disallow sub-agent delegation for the implementation agent.
- [ ] The review prompt: early-return guard → strict per-item verification →
      unit + manual tests → READY / NEEDS_WORK / BLOCKED → replace findings,
      uncheck failed items, never fix code.
- [ ] Completion scripts for `workflow_complete` (READY) and `workflow_blocked`
      (BLOCKED).

> The reference also records a Playwright video of the review's manual testing
> for the user to watch (the `videoConfig` wired up in `agentRunner.ts`). That's
> a nicety, not load-bearing — skip it if your harness has no browser-driving
> MCP.

## Reference map

| Concern | File |
|---|---|
| Implementation prompt | `reference/server/constants/prompts/implementation.md` |
| Review prompt | `reference/server/constants/prompts/review.md` |
| Prompt assembly + tool/video setup | `reference/server/constants/agentPrompts.ts`, `reference/server/services/agentRunner.ts` |
| Completion signals | `reference/scripts/complete-workflow.ts`, `reference/scripts/block-workflow.ts` |

## Boundaries (not in this spec)

- The chaining mechanics, the iteration cap, and how flags route the loop →
  [`orchestration-loop.md`](./orchestration-loop.md).
- A polishing pass between review and PR →
  [`refinement-agent.md`](../extra/refinement-agent.md).
- Opening the PR after READY → [`pull-request-agent.md`](./pull-request-agent.md).
