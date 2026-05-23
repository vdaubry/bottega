# Core — The planning agent

The first agent in the pipeline. It turns a rough request into a reviewable
implementation plan, written into the task doc, so everything downstream has a
concrete spec to execute against.

## What it delivers

> I write a one-line request (or a paragraph). The planning agent researches the
> codebase, asks me only the questions that genuinely matter, and writes a
> structured plan — phased steps, files to touch, a testing strategy, a to-do
> checklist — back into the task doc. I read it, and when it looks right I press
> Run to start implementation.

Planning is the **human gate** of the pipeline. It is the one place designed for
a person to review and course-correct *before* any code is written. After it,
the loop runs autonomously (see [`execution-loop.md`](./execution-loop.md)).

## Responsibility and constraints

The planning agent is **plan-only**. It must not implement code, change config,
or touch any repo file other than the task doc. Its entire allowed toolset is:

- spawn read-only research sub-agents,
- ask the user clarifying questions,
- write the plan to the task doc, and
- run the completion script.

Its single output is a markdown plan at the task doc path (see
[`task-and-workspace.md`](./task-and-workspace.md) for where that lives),
following a fixed template section-for-section.

**Preserve the original request verbatim.** Before overwriting the doc, the
agent reads it; whatever is there is the user's request as they wrote it. The
new plan must quote that pre-existing content verbatim in its `## Original
Request` section — never paraphrase or drop it. (Read before Write: once
written, the original is gone.)

## The workflow

1. **Explore (research sub-agent).** Spawn a read-only sub-agent to map the
   relevant code and return files with line numbers, the current architecture,
   dependencies, and any ambiguities. It must not write files, run scripts, or
   ask questions — research only. (If your harness has no sub-agents, the agent
   explores directly; the constraint that exploration is read-only still holds.)
2. **Clarify (the agent itself).** Ask the user questions **only** for genuine
   ambiguity with real trade-offs (e.g. "JWT or sessions?"), not for things with
   an obvious answer. Always propose and confirm a **testing strategy**. Make
   reasonable assumptions for everything else and proceed.
3. **Write the plan** to the task doc, following the template exactly.
4. **Verify and signal done.** Read the file back, then run the completion
   script, which sets `planification_complete`.

## The plan template is the contract

The plan must follow a fixed structure
([`reference/server/constants/templates/plan-template.md`](../reference/server/constants/templates/plan-template.md)):

- **Original Request** — the user's words, quoted verbatim.
- **Overview** — problem statement, scope, key decisions made.
- **Implementation Plan** — ordered phases, each listing the files to
  modify/create and what changes.
- **Testing Strategy** — unit tests and manual/Playwright scenarios (or an
  explicit "not needed because …").
- **To-Do List** — `Implementation` and `Testing` checkboxes.
- **Project Docs Update** — doc changes needed, or "Not needed."

### The critical rule: every to-do item is agent-executable

The workflow between planning and PR is fully autonomous — **no human acts in
between.** So every to-do item must be something the implementation agent can do
end-to-end on its own. The plan must **not** contain items that require:

- the user to act, approve, or test;
- deployment to any environment;
- manual git work or PR creation — a dedicated [PR agent](./pull-request-agent.md)
  owns all `git commit` / `push` / `gh pr create`;
- external services or credentials the agent lacks.

If a step can't be executed by the agent, leave it out — don't park it as an
unchecked "for later" item, because unchecked items block the loop. **The plan
ends when code and tests are done; the PR agent takes it from there.**

The resulting **to-do checklist is the contract between planning and execution**:
the implementation agent works the unchecked items, and the review agent
verifies the checked ones (see [`execution-loop.md`](./execution-loop.md)).

## Where it sits in the loop

When planning completes, the loop **stops** — the user reviews the plan and
presses Run to start implementation. That manual gate is the entire reason
planning is a separate step. (Auto-advancing past it for non-technical users,
and the tech/non-tech prompt split, are role behavior — see
[`auth-and-multi-user.md`](../extra/auth-and-multi-user.md).)

## What to build

- [ ] The planning prompt enforcing the plan-only constraints and the
      verbatim-original-request rule.
- [ ] A read-only research sub-agent step (or direct read-only exploration).
- [ ] The plan template.
- [ ] A completion script that sets `planification_complete` and the loop's
      stop-after-planning gate.

## Reference map

| Concern | File |
|---|---|
| Planning prompt | `reference/server/constants/prompts/planification.md` |
| Plan template | `reference/server/constants/templates/plan-template.md` |
| Prompt assembly | `reference/server/constants/agentPrompts.ts` (`generatePlanificationMessage`) |
| Completion signal | `reference/scripts/complete-plan.ts` (sets `planification_complete`) |
| Non-technical variant (extra) | `reference/server/constants/prompts/planification-nontechnical.md` |

## Boundaries (not in this spec)

- How the plan's checklist is executed and verified →
  [`execution-loop.md`](./execution-loop.md).
- The non-technical auto-advance and tech/non-tech prompt split →
  [`auth-and-multi-user.md`](../extra/auth-and-multi-user.md).
- Customizing the planning prompt per project/user →
  [`prompt-and-model-customization.md`](../extra/prompt-and-model-customization.md).
