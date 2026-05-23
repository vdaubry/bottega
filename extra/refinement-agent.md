# Extra — The refinement agent

## What it adds

A single optional polish pass that runs **after review approves the work and
before the PR is opened**. When review signals READY (`workflow_complete`),
instead of going straight to the PR agent, the loop first runs a **refinement**
agent that cleans up the just-written code: it simplifies the diff for clarity
and runs a security pass over it, applying fixes in place. Only then does the
PR agent run. The reviewed work ships a little tidier and a little safer,
without a human in the loop.

## Why it's an extra (not core)

Shipping a reviewed change as a PR is universal; an extra cleanup pass before
that PR is a matter of taste. Remove this extra and the finish pipeline goes
straight `workflow_complete → PR`, exactly as core describes.

## Where it inserts

The finish pipeline lives in the completion handler's `workflow_complete`
branch — see `handleAgentChaining` in
[`../reference/server/services/conversation/agentRunLifecycle.ts`](../reference/server/services/conversation/agentRunLifecycle.ts).
Core's version of that branch reads "if `workflow_complete` and not yet
`pr_agent_complete`, start the PR agent." This extra wedges one check **in
front of** the PR check:

- `workflow_complete` is set, and the finishing agent was **not** refinement,
  and `refinement_complete` is **not** yet set → start the **refinement** agent
  and return. Do not start PR yet.
- The finishing agent **was** refinement → call `tasksDb.markRefinementComplete`
  (sets `refinement_complete`) and fall through to the PR check, which now
  starts the PR agent.

So a single refinement run is threaded in: review → refinement → PR. The
ordering is the whole trick — the refinement check sits between the
`workflow_complete` gate and the `pr_agent_complete` gate, the same way core's
PR check does. Refinement is one of the agent types that the completion handler
treats as chainable (alongside planning, implementation, review); see the
`shouldChain` set in `buildAgentRunCompletionHandler` in the same file. The PR
agent remains terminal.

Because the gate is the persistent `refinement_complete` flag (not "did
refinement just run"), refinement runs **at most once** per task: a second trip
through the `workflow_complete` branch finds the flag already set and skips
straight to PR. `tasksDb.markRefinementComplete` and the companion
`resetRefinementComplete` live in
[`../reference/server/database/db.ts`](../reference/server/database/db.ts); the
column is declared in
[`../reference/server/database/init.sql`](../reference/server/database/init.sql)
(`refinement_complete INTEGER DEFAULT 0 NOT NULL`).

## What the agent actually does

The prompt is [`../reference/server/constants/prompts/refinement.md`](../reference/server/constants/prompts/refinement.md).
It is built like any other agent message — `generateRefinementMessage`
(taskDocPath + taskId) in
[`../reference/server/constants/agentPrompts.ts`](../reference/server/constants/agentPrompts.ts)
renders it through the prompt engine — and runs through the standard
`startAgentRun` path in
[`../reference/server/services/agentRunner.ts`](../reference/server/services/agentRunner.ts)
(the `case 'refinement'` branch).

The agent works in three steps:

1. **Spawn two sub-tasks in parallel** in a single turn (it uses the Agent/Task
   tool here — refinement is *not* in the sub-agent-disallowed set, unlike
   implementation and yolo):
   - **Code simplification** — diff `main` to find the modified files, read
     them, and simplify for clarity: drop unnecessary complexity, improve
     naming, reduce duplication, simplify conditionals. Behavior must be
     preserved; only files changed on this branch may be touched; test files
     and the task doc are off-limits. This sub-task **applies its changes
     directly.**
   - **Security review** — a read-only OWASP-style pass over the diff that
     produces a report of HIGH/MEDIUM findings at confidence ≥ 8, each with
     file, line, severity, and a recommended fix. It **modifies nothing**; it
     only reports.
2. **Apply the security fixes** — after both sub-tasks return, the parent reads
   the security report and applies each qualifying fix to the affected files.
3. **Log a short summary** — counts of simplifications and security fixes and
   the files touched.

Hard constraints baked into the prompt: never edit the task doc, never run a
completion script, never ask questions, never run tests (the PR agent owns CI).
Refinement signals "done" simply by ending its turn — there is no refinement
script. The flag is flipped by the **orchestrator** (`markRefinementComplete`)
when it sees refinement was the finishing agent, not by the agent itself.

## When to install it

Install refinement when you want an automated tidy-and-harden step on every
reviewed change before it becomes a PR — and you accept that it costs an extra
agent run (and a sub-agent fan-out) per task, and that it edits code after the
reviewer already blessed it. Skip it if you'd rather the reviewed diff reach the
PR untouched.

## What to build

- [ ] A `refinement_complete` boolean on the task row, plus a setter
      (`markRefinementComplete`) and ideally a reset.
- [ ] The refinement prompt: spawn the two parallel sub-tasks (simplification +
      read-only security review), then apply the security fixes, then summarize
      — with the "no doc edits / no scripts / no tests / no questions"
      constraints.
- [ ] A `refinement` branch in the agent-message builder and in `startAgentRun`
      (no `disallowedTools` restriction — refinement *needs* the sub-agent
      tool).
- [ ] In the completion handler's `workflow_complete` branch, insert the
      refinement check **before** the PR check: start refinement if
      `refinement_complete` is unset and the finisher wasn't refinement; when
      the finisher *was* refinement, set the flag and fall through to PR.
- [ ] `refinement` in the chainable agent-type set so the completion handler
      routes after it.

## Reference map

| Concern | File |
|---|---|
| Insertion point + flag flip | `../reference/server/services/conversation/agentRunLifecycle.ts` (`handleAgentChaining`, `workflow_complete` branch) |
| What the agent does (prompt) | `../reference/server/constants/prompts/refinement.md` |
| Message assembly | `../reference/server/constants/agentPrompts.ts` (`generateRefinementMessage`) |
| Run start (no sub-agent ban) | `../reference/server/services/agentRunner.ts` (`case 'refinement'`) |
| Flag setter | `../reference/server/database/db.ts` (`markRefinementComplete`, `resetRefinementComplete`) |
| Column | `../reference/server/database/init.sql` (`refinement_complete`) |
| UI completion state | `../reference/src/components/AgentSection.tsx` (refinement → `refinementComplete`) |

## Boundaries (not in this spec)

- The state machine the refinement check lives inside (chaining, the
  `workflow_complete`/`pr_agent_complete` gates, the iteration cap) →
  [`../core/orchestration-loop.md`](../core/orchestration-loop.md).
- The review step that sets `workflow_complete` upstream →
  [`../core/execution-loop.md`](../core/execution-loop.md).
- The PR agent that runs after refinement →
  [`../core/pull-request-agent.md`](../core/pull-request-agent.md).
- The single-agent path that skips this pipeline entirely →
  [`./yolo-mode.md`](./yolo-mode.md).
