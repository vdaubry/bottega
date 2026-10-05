# Delivery — the epic's final pull request

Every epic finishes with one pull request from `epic/{id}-{slug}` into the
repo's default branch. Getting it merged is its own body of work — conflicts
with a default branch that moved on for weeks, CI, review comments, questions
about what the epic actually delivered — and until this landed there was
nowhere to do it: the tickets were merged, their worktrees deleted, their
agents gone, and a `@`-mention on the final pull request was silently ignored.

**Delivery** is that place: one epic agent type (`epic-delivery`), one worktree,
one section on the epic page, and two ways in — the user, and GitHub.

The branch lifecycle it operates on is [`feature-branch.md`](./feature-branch.md);
the stage that runs before it is [`orchestrator.md`](./orchestrator.md).

## It is not a stage — and that is the design

The four framing stages each own a flag on the `epics` row, and each flag gates
the next stage. Delivery gates nothing: the epic ends when a human merges the
pull request. So it deliberately has

- **no column** on `epics`,
- **no predecessor** in `checkStageGate` — no stage flag is consulted,
- **no `mark_stage_complete`** (its Bottega tool catalog is empty),
- **no row** in `EpicStageRail`, and no entry in `STAGE_BY_AGENT_TYPE`
  (`server/services/epics/epicStages.ts` maps it to `null`, exhaustively, so
  adding an agent type stays a decision taken there).

It is an agent with a section, not a stage with a flag. Everything else about
it — the run row, the conversation, the WS events, the model setting, the
prompt override — is the ordinary epic-agent machinery.

## Why an agent type rather than a plain conversation

`POST /epics/:id/conversations` already creates an owner-less epic chat, and it
would have carried a webhook comment as its first message. It cannot carry the
rest:

- **Model resolution.** A manual conversation gets provider/model from the
  picker in the modal. The webhook has no human present, so it must read
  `loadAgentModelSettings(userId)['epic-delivery']`. Anything else means
  defaulting a model, which this codebase never does.
- **Orphan recovery.** A run interrupted by a restart is swept to `failed` by
  the epic adapter's `sweepOrphans`. A bare conversation would read as running
  forever.
- **One at a time.** `getRunningAgentForEpic` is what lets a second comment
  arriving mid-turn be refused rather than racing the first.
- **A status chip**, so the section can say what a conversation is doing.

So both entry points create an `epic-delivery` run, and the section lists one
homogeneous kind of row.

## The delivery worktree

`{repo}-worktrees/epic-{id}`, the epic's feature branch checked out — created on
demand, reused by every delivery run, removed only when the epic is deleted.

Every other epic conversation runs in the project's **main checkout**, and every
git operation `epicBranch.ts` performs there is deliberately HEAD-preserving
(`fetch`, `ls-remote`, `rev-list`, `gh pr create`). Delivery cannot follow that
rule: merging `origin/{default}` into the feature branch and resolving the
conflicts means having the branch checked out somewhere, and doing it in the
main checkout would move the HEAD of the working copy a person is using — on a
self-hosting box, the one the running service is serving.

The invariant becomes precise rather than broken: **an epic has no worktree
while framing; delivery has one, and it is the feature branch itself.**

## It is also what you preview

The same worktree is what "switch server" points the project's NGINX symlink at
when you serve an epic — the only way to click through a finished epic at its
real URL, because each ticket's worktree is deleted when it merges. The switch
itself is the existing mechanism pointed somewhere new
([`../web-server/switch-server.md`](../web-server/switch-server.md)).

Making that tree *runnable* — dependencies, env files, runtime directories — is
the project's job, through its own `post-checkout` hook, which git runs inside
`git worktree add` here exactly as it does for a ticket
([`../agents/worktree-provisioning.md`](../agents/worktree-provisioning.md)).
Bottega adds nothing on top: a hookless repo yields a bare checkout.

| Function (`epics/epicBranch.ts`) | |
|---|---|
| `ensureEpicDeliveryWorktree(epic)` | idempotent (an `fs.access` when it exists) and serialized per epic — a webhook comment landing while the user clicks "New conversation" would otherwise race two `git worktree add` calls onto one path. Checks out the local branch, or `-b {branch} origin/{branch}` when only origin has it. `git worktree add` fires the project's `post-checkout` hook (with a 10-minute budget — hooks install dependencies); a failed add is swept via `cleanupFailedWorktreeAdd` before rethrowing, so a half-provisioned tree cannot pass the "already there" check on the next attempt. Throws when the epic has no `feature_branch`. |
| `removeEpicDeliveryWorktree(repo, epicId, {force})` | refuses a worktree holding uncommitted work unless forced, and **never deletes the branch** — `epic/{id}-{slug}` is what the final pull request merges and outlives worktree, epic row and this call. (`removeWorktree` deletes a *ticket's* branch; this is why delivery does not reuse it.) |
| `findEpicCompletionPR(epic)` | read-only best-effort lookup of the open PR, so the prompt can name it. A repo with no `gh`/origin degrades to "not opened yet" rather than stopping a conversation. Opening one stays `createEpicCompletionPR`, behind the user's button. |

`resolveScope` (`epics/adapter.ts`) routes a `{kind:'epic', deliveryWorktree:
true}` target there and re-ensures it on every turn, so a conversation resumed
after the directory went missing recreates it instead of failing inside the
provider subprocess.

## The agent

`startEpicAgentRun(epicId, 'epic-delivery', { deliveryTrigger })`:

- **Tool surface: everything** (`EPIC_DELIVERY_DISALLOWED_TOOLS = []`), like the
  orchestrator and the PR reviewer. Its cwd IS a worktree of the branch it
  changes, so a write lands where it belongs by construction rather than by
  instruction. `AskUserQuestion` stays on, unlike `epic-pr-review`: half of
  delivery's runs *are* a conversation the user opened, and the other half is
  feedback whose intent only its author knows. Nothing is sequenced behind the
  turn, so a parked question costs nothing.
- **Bottega tools: none.** It acts on GitHub and on the feature branch with
  `git` and `gh`; there is no Bottega row for it to change. It signs no stage
  off, creates no ticket, merges no task.
- **Writable archive dirs: none** — and therefore no write gate.
- **Nothing chains** on turn end; the adapter only chains for the orchestrator
  and the PR reviewer.
- The worktree is ensured **before** the run row is created, so an epic with no
  feature branch fails loudly at start rather than half-way through a turn.

The prompt (`server/constants/prompts/epic-delivery.md`) frames where it is —
worktree, both branches, the pull request, the tickets the epic delivered — and
carries the hard rules: never merge the final pull request (the user's act,
always), never force-push or rebase the shared feature branch (merge into it —
its tickets branched off it), never touch the main checkout. The epic's
documents are not inlined: `buildEpicContextPrompt` already hands over the
archive paths, and a conflict resolution rarely needs the whole specification.

## Two ways in

### The user

**Main → Delivery → New conversation** posts to the generic
`POST /epics/:id/agent-runs` with `agentType: 'epic-delivery'` — the same call
every stage's Start button makes, so the page navigates into the conversation
exactly as it does for a stage. The one gate: the epic must have a
`feature_branch` (created with its first ticket). Deliberately **not** "every
ticket merged" — a comment can land on the final pull request at any point.

### GitHub

A comment or review carrying the configured `@`-trigger on the final pull
request. `parseTaskIdFromBranch` is anchored on `^task/`, so the epic branch
matched nothing and the route answered `200 {status:'ignored'}` — a delivery
GitHub records as successful, with nothing to show for it.

`parseEpicIdFromBranch` (`^epic\/(\d+)-`) is its counterpart, and
`resolveBranchOwner` in `server/routes/webhooks.ts` tries task, then epic. Both
parsers are anchored, so a branch resolves to a task, to an epic, or to
neither — never both, which is what lets the dispatch be a plain if/else
(regression-tested over every branch shape).

An epic owner routes to `triggerEpicDeliveryFrom{Comment,Review}`
(`epics/deliveryWebhook.ts`), the epic twin of `webhookService.ts`'s task pair:
same pre-checks, same "already running" refusal, same `TriggerResult`. It lives
in the epic layer because it reads epic rows and starts an epic run
(architecture-v2 rule 1) — which makes `routes/webhooks.ts` the **second REST
adapter** into that layer, alongside `routes/epics.ts`, and it is listed as such
in the boundary lint.

Both feedback shapes are quoted by `server/constants/prFeedback.ts`, shared with
the ticket-level `pr` agent, so a comment reads identically wherever it lands.

`respondToTriggerFailure` is the one place a failed trigger becomes a response,
for both owners and both event kinds. Everything that means "nothing to do
here" — not found, already running, no feature branch, no owning user, and
(new for both paths) a missing provider credential or model setting — answers
**200**: a 500 makes GitHub retry, and every retry lands in the same state.

## The Delivery section

`EpicDeliverySection`, third on the Main tab under Framing and Implementation:

- **Header** — the state sentence, **New conversation**, and **Open final PR**.
- **Header** — also carries **Switch Server**: preview this epic's feature branch
  at the project URL, with the green *Active Server* state and its reset, the
  same control the task page uses (`ServeSwitchButton`).
- **Body** — every `epic-delivery` run's conversation, newest first (whatever
  just happened is on top), labelled by its conversation name with its run
  status chip. The name is the AI title generated from the first turn, so a
  webhook-started conversation reads as what the comment asked for; before it
  lands the row falls back to `Delivery conversation #n`.

Both buttons say why they are disabled rather than letting the user meet a bare
error: New conversation needs the feature branch and no other epic agent
running; Open final PR needs every ticket merged, and counts the ones that are
not — the same refusals `checkStageGate` and `createEpicCompletionPR` enforce
server-side.

**"Open final PR" moved here** from `OrchestrationActionButton`, which folded it
into the orchestration state machine as a fourth action after
Start/Pause/Resume. Opening the epic's own pull request is not an orchestration
step, and `primaryOrchestrationAction` now returns `null` once every ticket has
merged: the stage is over and offers nothing. The Implementation header says so
and points here.

The page refetches on `conversation-added` and `conversation-name-updated` as
well as the existing events — a webhook-started conversation belongs to no click
of the user's, and its title lands after its first turn.

## Key files

- `server/constants/prompts/epic-delivery.md` — the prompt.
- `server/services/epics/epicBranch.ts` — the delivery worktree + `findEpicCompletionPR`.
- `server/services/epics/deliveryWebhook.ts` — the inbound GitHub half.
- `server/services/epics/epicAgentPrompts.ts` — `generateEpicDeliveryMessage`, `EpicDeliveryTrigger`.
- `server/services/epics/epicAgentRunner.ts` — the `epic-delivery` case.
- `server/services/epics/adapter.ts` — `resolveScope`'s delivery branch.
- `server/services/webhookService.ts:65` — `parseEpicIdFromBranch`.
- `server/routes/webhooks.ts` — `resolveBranchOwner`, `respondToTriggerFailure`.
- `server/routes/epics.ts` — the `epic-delivery` gate; the delete route's worktree cleanup.
- `server/constants/prFeedback.ts` — comment/review quoting, shared with the `pr` agent.
- `server/database/db.ts` — `widenEpicAgentRunTypeCheck` (the `agent_type` CHECK rebuild).
- `server/services/epics/serveTarget.ts` — the switch-server resolver (serve this epic).
- `src/components/epic/EpicDeliverySection.tsx` — the section.
- `src/components/epic/orchestrationAction.ts` — orchestration without `open-pr`.
