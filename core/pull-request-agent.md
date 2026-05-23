# Core — The pull-request agent

The terminal agent. It takes the verified work sitting in the task's worktree
and gets it to a green, mergeable pull request — opening the PR, driving CI to
pass, resolving conflicts — then signals the pipeline complete. It does **not**
merge; a human does that.

## What it delivers

> Once the work passes review, the PR agent commits and pushes the branch, opens
> a pull request, watches CI, fixes whatever's red, rebases away any conflicts,
> and stops once the PR is green and mergeable. I get a PR ready to merge without
> having touched git.

## When it runs

After review signals READY (`workflow_complete`) the loop enters its finish
pipeline and starts the PR agent. (If the [refinement extra](../extra/refinement-agent.md)
is installed, it runs just before.) **PR is terminal** — nothing chains after
it. See [`orchestration-loop.md`](./orchestration-loop.md).

## Inputs

The orchestrator passes the agent the task doc path, the task id, and the
**current PR status** — it computes up front whether a PR already exists for this
task's branch and hands in the URL if so. That status decides the first step
below. See `generatePrAgentMessage` / `buildPrCreateOrVerifyBlock` in
[`reference/server/constants/agentPrompts.ts`](../reference/server/constants/agentPrompts.ts).

## The procedure

1. **Create or verify the PR.**
   - If a PR already exists for the branch → skip to CI.
   - Otherwise: commit any uncommitted changes; confirm there are commits ahead
     of the base branch — **if nothing is ahead and nothing was uncommitted,
     there's nothing to submit**, so run the completion script and stop; push
     the branch; open the PR (`gh pr create`) with a short title and a concise
     summary referencing the task.
2. **Monitor CI.** Poll the PR's checks on a bounded loop (sleep between polls,
   capped attempts).
3. **Handle the result.**
   - *Pending* → wait and re-poll (capped).
   - *Passed* → go to the conflict check.
   - *Failed* → pull the failing logs, fix the cause in the worktree, commit and
     push, and re-poll — on a bounded number of fix iterations.
4. **Conflict check (once CI is green).** Inspect the PR's mergeability.
   - *Mergeable* → run the completion script that sets `pr_agent_complete`.
   - *Conflicting* → rebase onto the base branch, resolve, force-push with lease,
     re-check CI (bounded attempts).
   - *Unknown* → wait and re-check (the host may still be computing it).

## Constraints

- **Never merge** — the user merges manually.
- **Bounded iteration** on every loop (CI polling, fix attempts, conflict
  resolution). If it can't reach green-and-mergeable within the caps, document
  the persistent failure and stop rather than spin forever.

## Completion signal

Running the completion script sets `pr_agent_complete` — the pipeline's terminal
state. Merging the PR and tearing down the worktree afterward is a separate,
human-initiated action (`mergeAndCleanup` in
[`reference/server/services/worktree.ts`](../reference/server/services/worktree.ts));
the agent never does it.

## The git surface it relies on

The agent works through the `gh` CLI and git inside the worktree, so its sandbox
needs `gh` auth and push rights (wiring those credentials is a harness/extra
concern). The server side provides: detect-existing-PR-and-URL, create-PR, and
commit/push helpers — see `getPullRequestStatus`, `createPullRequest`,
`commitAllChanges`, `pushChanges` in `worktree.ts`.

## Why the PR agent is core (but refinement isn't)

Shipping a reviewed change as a pull request is the universal end of any task —
every team does it. Extra polishing passes before the PR are a matter of taste,
which is why [refinement](../extra/refinement-agent.md) is an extra and this is
not.

## What to build

- [ ] The PR prompt: a create-or-verify opening, the CI poll loop, the fix loop,
      conflict resolution, and the completion call — all bounded.
- [ ] Server helpers: detect existing PR + URL, create PR, commit/push, wrapping
      git + `gh`.
- [ ] A completion script that sets `pr_agent_complete`.
- [ ] Compute the PR status at run start and pass it into the prompt.

## Reference map

| Concern | File |
|---|---|
| PR prompt | `reference/server/constants/prompts/pr.md` |
| Prompt assembly + create/verify block | `reference/server/constants/agentPrompts.ts` |
| Completion signal | `reference/scripts/complete-pr.ts` (sets `pr_agent_complete`) |
| PR + git helpers | `reference/server/services/worktree.ts` (`getPullRequestStatus`, `createPullRequest`, `commitAllChanges`, `pushChanges`, `mergeAndCleanup`) |

## Boundaries (not in this spec)

- Re-running the PR agent automatically when the PR gets review comments →
  [`pr-comment-retrigger.md`](../extra/pr-comment-retrigger.md).
- Merging and worktree teardown as a user action →
  [`task-and-workspace.md`](./task-and-workspace.md).
- How completion fits the overall state machine →
  [`orchestration-loop.md`](./orchestration-loop.md).
