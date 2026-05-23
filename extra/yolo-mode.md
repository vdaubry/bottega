# Extra — YOLO mode

## What it adds

A **single-agent alternative to the five-step pipeline.** Instead of chaining
planning → implementation ⇄ review → (refinement) → PR across separate agent
runs, a YOLO task hands the whole job to **one agent in one continuous
conversation** that plans, implements, tests, opens the PR, and drives CI to
green — all itself. You pick it once, at task-creation time, and press Run once.

## Why it's an extra (not core)

The multi-agent pipeline is the product's core value proposition: separate,
observable steps with an independent reviewer. YOLO collapses all of that into
one agent — faster and simpler, but with no separation of powers and one long
turn to watch. That's a deliberate trade-off some teams want and others
don't, so it's opinion, not core.

## Chosen at task creation

YOLO is a property of the **task**, set when the task is created, via a
`yolo_mode` boolean:

- The create handler reads `yolo_mode` off the request body and passes it into
  `tasksDb.create` — see
  [`../reference/server/routes/tasks.ts`](../reference/server/routes/tasks.ts)
  (the `POST /projects/:projectId/tasks` handler, `!!yolo_mode`). The field is
  declared on the create schema in
  [`../reference/shared/schemas/tasks.ts`](../reference/shared/schemas/tasks.ts)
  (`yolo_mode: z.boolean().optional()`).
- It persists as a column on the task row:
  [`../reference/server/database/init.sql`](../reference/server/database/init.sql)
  (`yolo_mode INTEGER DEFAULT 0 NOT NULL`).

Creation only records the flag — it does **not** auto-start anything. The YOLO
run begins like any manual run: the user presses Run, which hits
`POST /api/tasks/:taskId/agent-runs` with `agentType: 'yolo'` and lands in the
same `startAgentRun` entry point every other agent uses.

## One agent, one conversation, terminal

The whole pipeline happens inside one streaming conversation. The prompt
[`../reference/server/constants/prompts/yolo.md`](../reference/server/constants/prompts/yolo.md)
walks the agent through five phases in sequence:

1. **Plan** — append an Overview, a checkbox To-Do List, and a Testing Strategy
   (automated + manual layers) to the task doc.
2. **Implement** — work the To-Do List, checking items off.
3. **Test** — execute every Testing Strategy checkbox, fixing failures before
   ticking a box.
4. **Mark workflow complete** — run `complete-workflow.ts` (sets
   `workflow_complete`).
5. **PR + CI** — create-or-verify the PR, poll CI, fix failures, resolve
   conflicts, and finish by running **`complete-pr.ts`** (sets
   `pr_agent_complete`).

That last script is what makes YOLO **terminal**: completing the run sets
`pr_agent_complete`, the same flag the core PR agent sets, so there is nothing
left to chain. The completion handler treats a finished `yolo` run like a
finished `pr` run — `yolo` is *not* in the chainable agent-type set in
`buildAgentRunCompletionHandler`
([`../reference/server/services/conversation/agentRunLifecycle.ts`](../reference/server/services/conversation/agentRunLifecycle.ts)),
so when its stream ends the run is marked completed and the loop simply stops.
YOLO never enters the implementation ⇄ review toggle or the
`workflow_complete → (refinement) → PR` finish pipeline; it *is* the whole
pipeline, run by one agent.

The agent message is built by `generateYoloMessage` (taskDocPath, taskId, and
the current PR URL) in
[`../reference/server/constants/agentPrompts.ts`](../reference/server/constants/agentPrompts.ts).
It deliberately **reuses the PR agent's create-or-verify block**:
`buildPrCreateOrVerifyBlock` renders the same "PR already exists → verify"
vs. "no PR yet → commit, push, `gh pr create`, and if nothing's ahead just run
the completion script and stop" step that `generatePrAgentMessage` uses, and
inlines it into the yolo prompt. So the PR/CI tail of YOLO behaves identically
to the dedicated PR agent — see
[`../core/pull-request-agent.md`](../core/pull-request-agent.md).

## No sub-agents — keep it one observable turn

The whole appeal of YOLO is *one* conversation you can watch end to end. To
protect that, the Agent/sub-agent tool is **disallowed** for yolo runs, exactly
as it is for the core implementation agent — otherwise the agent could spawn an
opaque sub-agent that runs for hours with zero visibility in the parent
transcript. See `disallowedTools` in
[`../reference/server/services/agentRunner.ts`](../reference/server/services/agentRunner.ts):
`agentType === 'implementation' || agentType === 'yolo'` → `['Agent']`. (Note
this is the opposite of the refinement extra, which *needs* sub-agents — see
[`./refinement-agent.md`](./refinement-agent.md).)

## How the UI surfaces it

The agent panel filters its agent list by the task's `yolo_mode`: a YOLO task
shows **only** the YOLO agent; a normal task shows everything **except** YOLO.
See `AgentSection` in
[`../reference/src/components/AgentSection.tsx`](../reference/src/components/AgentSection.tsx)
— `AGENT_TYPES.filter(a => yoloMode ? a.type === 'yolo' : a.type !== 'yolo')`.
The same component computes the YOLO agent's "completed" state from
`pr_agent_complete` (the same flag the PR agent's card uses), which is why a
finished YOLO run reads as done even though it never ran a separate PR step.

## When to use which

- **Pipeline (default).** Larger or higher-stakes work where the independent
  skeptical reviewer and the human plan-gate earn their keep, and where
  watching distinct planning/implementation/review steps matters.
- **YOLO.** Smaller, well-scoped, lower-risk tasks where the overhead of five
  chained runs (and a human plan-gate) isn't worth it and you just want one
  agent to take it from prompt to green PR.

## What to build

- [ ] A `yolo_mode` boolean on the task row, on the create schema, and read by
      the create handler into `tasksDb.create`.
- [ ] A `yolo` agent type (in the agent-type enum) startable through the normal
      `startAgentRun` / `POST /agent-runs` path.
- [ ] The yolo prompt: plan → implement → test → `complete-workflow` →
      create-or-verify PR → CI loop → `complete-pr`, reusing the PR agent's
      create-or-verify block.
- [ ] Disallow the sub-agent tool for `yolo` (same set as implementation).
- [ ] Treat `yolo` as terminal — keep it **out** of the chainable set so the
      loop stops when its run ends.
- [ ] UI: filter the agent panel by `yolo_mode` (yolo-only vs. everything-else)
      and compute its completion from `pr_agent_complete`.

## Reference map

| Concern | File |
|---|---|
| Create with the flag | `../reference/server/routes/tasks.ts` (`POST .../tasks`), `../reference/shared/schemas/tasks.ts` |
| Column | `../reference/server/database/init.sql` (`yolo_mode`) |
| The prompt (5 phases + reused PR block) | `../reference/server/constants/prompts/yolo.md` |
| Message assembly + shared PR block | `../reference/server/constants/agentPrompts.ts` (`generateYoloMessage`, `buildPrCreateOrVerifyBlock`) |
| Run start + sub-agent ban | `../reference/server/services/agentRunner.ts` (`case 'yolo'`, `disallowedTools`) |
| Terminal (not chained) | `../reference/server/services/conversation/agentRunLifecycle.ts` (`yolo` absent from `shouldChain`) |
| UI filtering + completion state | `../reference/src/components/AgentSection.tsx` |

## Boundaries (not in this spec)

- The multi-agent state machine YOLO replaces (chaining, the toggle, the gates,
  the iteration cap) → [`../core/orchestration-loop.md`](../core/orchestration-loop.md).
- The plan / implementation / review steps YOLO compresses →
  [`../core/planning-agent.md`](../core/planning-agent.md),
  [`../core/execution-loop.md`](../core/execution-loop.md).
- The PR/CI procedure whose create-or-verify block YOLO reuses →
  [`../core/pull-request-agent.md`](../core/pull-request-agent.md).
- The polish pass YOLO skips → [`./refinement-agent.md`](./refinement-agent.md).
