# Extra — PR-comment re-trigger (GitHub webhook)

## What it adds

A GitHub webhook endpoint that re-runs the [PR agent](../core/pull-request-agent.md)
automatically when a reviewer leaves activity on a Bottega-opened PR. A human
comments `@bottega please rename this` on the PR (or submits a review with
inline comments); GitHub posts the event to Bottega; Bottega maps the PR back to
its task, builds a feedback prompt from the comment(s), and starts a fresh PR
agent run that addresses the feedback, pushes, drives CI green again, and stops.
No human re-presses Run.

## Why it's an extra (not core)

Core's trigger surface is **manual Run + internal chaining**, and PR is terminal
— nothing reopens it ([`orchestration-loop.md`](../core/orchestration-loop.md)).
Reacting to *GitHub* events is one team's opinion about where feedback comes
from; another team might wire re-triggers to Linear, Slack, or nothing at all.
So this lives outside the core loop. It changes none of the state machine: it is
simply a new way to call the same `startAgentRun(taskId, 'pr', …)` entry point
the loop already uses.

## The two entry points

A single Express router, mounted at `/api/webhooks`, exposes:

- **`POST /github`** — the event sink. GitHub-signed, no app JWT.
- **`GET /health`** — a tiny liveness probe that also reports whether
  `GITHUB_WEBHOOK_SECRET` is configured. Useful for confirming a deployment is
  reachable from GitHub and that the secret is wired. See the handler at the
  bottom of [`reference/server/routes/webhooks.ts`](../reference/server/routes/webhooks.ts).

## Signature verification is the whole auth story

There is **no app JWT** on this route — the caller is GitHub, not a logged-in
Bottega user. Authenticity comes entirely from GitHub's HMAC signature:

- GitHub signs each delivery with the shared `GITHUB_WEBHOOK_SECRET` and sends
  the result in the `X-Hub-Signature-256` header.
- Bottega recomputes `sha256=` + `HMAC-SHA256(rawBody, secret)` and compares with
  a **constant-time** equality check (`crypto.timingSafeEqual`). A mismatch, a
  missing signature, or a missing secret → reject with `401`. See
  `validateGitHubWebhookSignature` in
  [`reference/server/services/webhookService.ts`](../reference/server/services/webhookService.ts).
- **Verify against the raw request bytes, not a re-serialized object.** HMAC is
  byte-sensitive; `JSON.parse` → `JSON.stringify` will not round-trip
  identically. The reference mounts the route with `express.raw({ type:
  'application/json' })` **before** `app.use(express.json())` so the handler sees
  the original `Buffer`, verifies it, *then* parses — see
  [`reference/server/index.ts`](../reference/server/index.ts) (the comment "must
  be before express.json()"). Getting the body-parser order wrong is the #1 way
  this silently 401s every delivery.

## Which events count, and the gating `@mention`

The handler only acts on two event types (the `X-GitHub-Event` header):
`issue_comment` (a top-level PR comment) and `pull_request_review` (a submitted
review, which may carry inline comments). Everything else returns `200 {status:
"ignored"}` — return 200, not an error, so GitHub doesn't keep retrying noise.
Further filtering, in order:

- **Action filter.** Only `issue_comment` with `action: "created"` and
  `pull_request_review` with `action: "submitted"`.
- **PR-only.** An `issue_comment` is ignored unless `issue.pull_request` is
  present (issues that aren't PRs don't apply).
- **`@mention` gate.** The event must mention the configured trigger handle
  (case-insensitive `@<trigger>`), so reviewers can converse freely and only
  summon the agent on purpose. The trigger string is **not hardcoded** — it's
  read from `app_settings.github_pr_trigger` (default `bottega`, editable from
  the UI), via `getConfiguredTrigger` / `hasTriggerMention` in
  `webhookService.ts`. For reviews, the mention may appear in the review body
  *or* in any of its inline comments.

## Mapping a PR event back to a Bottega task

The webhook knows a PR; Bottega needs a task id. The bridge is the **branch
naming convention** — Bottega names every task branch `task/{id}-{slug}`, so the
id is recoverable from the branch:

- For `pull_request_review`, the branch is in the payload
  (`pull_request.head.ref`).
- For `issue_comment`, the payload has no branch, so the handler fetches it with
  `gh pr view <n> --json headRefName` (`fetchPrBranchName` in `webhooks.ts`).
- `parseTaskIdFromBranch` (`webhookService.ts`) applies `^task\/(\d+)-` and
  returns the numeric id, or `null` (→ `200 ignored`) if the branch isn't a
  Bottega branch.

This is why core's task/worktree spec fixes the branch name format — it's the
join key. See [`task-and-workspace.md`](../core/task-and-workspace.md).

## Two re-trigger flavors → two prompts

Both flavors converge on `startAgentRun(taskId, 'pr', { webhookContext })`, but
they assemble different feedback bodies and pass a differently-shaped
`webhookContext`. The selection happens in the `pr` branch of `startAgentRun`
([`reference/server/services/agentRunner.ts`](../reference/server/services/agentRunner.ts)):
if `webhookContext.comments` is present → review flavor; else if any
`webhookContext` → comment flavor; else the plain create-or-verify PR prompt.

| Flavor | Source | Service fn | Prompt builder |
|---|---|---|---|
| **Single comment** | one `@mention` PR comment | `triggerPrAgentFromComment` | `generatePrAgentCommentMessage` |
| **Review batch** | a submitted review + N inline comments | `triggerPrAgentFromReview` | `generatePrAgentReviewMessage` |

Both builders (in
[`reference/server/constants/agentPrompts.ts`](../reference/server/constants/agentPrompts.ts))
render the **same** `pr-feedback.md` template but inject a different
`feedbackSection`:

- **Comment** quotes the single comment, attributes it to its author, and — if
  the comment was anchored to a file — appends a "Comment Location" block (path,
  line/line-range derived from `line`/`start_line`, `side` translated to
  "before/after changes") and the `diff_hunk` as a fenced diff.
- **Review** renders an optional "Review Summary" (the review body) followed by
  an "Inline Comments (N)" list, each entry numbered with its file/line and a
  collapsible diff-hunk `<details>`.

For reviews, the inline comments aren't in the webhook payload — the handler
calls `gh api repos/{repo}/pulls/{n}/reviews/{reviewId}/comments`
(`fetchReviewComments`) to fetch them, then normalizes each into `{commentBody,
commentAuthor, fileContext}`.

The resulting prompt (`pr-feedback.md`,
[`reference/server/constants/prompts/pr-feedback.md`](../reference/server/constants/prompts/pr-feedback.md))
tells the agent to address every feedback item at its file/line, test, commit +
push, re-poll CI, resolve conflicts, and finally run `complete-pr.ts` — the same
bounded CI/conflict procedure as the normal PR prompt. **This reuses the normal
PR agent and the normal completion flow**: the run is an ordinary `pr`-type
`task_agent_runs` row with a linked conversation; its stream end hits the same
completion handler; chaining still does nothing after PR (terminal). The webhook
adds an *input*, not a new agent.

## Trigger-time guards (in the service)

`triggerPrAgentFromComment` / `triggerPrAgentFromReview` re-validate before
spending a run, throwing if any precondition fails (the route maps these "not
ready" errors back to `200 ignored` rather than `500`):

- Task exists and is **not `completed`**.
- The task's **worktree still exists** (the agent needs a place to work).
- **No PR agent already `running`** for this task — the same "one running agent
  per task" rail core enforces, re-checked here because the webhook is an
  out-of-band start.
- The task has an **owning user**; the run executes *as the task owner*
  (`userId: taskOwner.id`) so it resolves that user's harness/model/credentials —
  there is no acting browser session to infer identity from.

On success the route returns `200 {status: "triggered", taskId, conversationId}`.
Genuine server faults (not the "not ready" set) return `500`.

## Streaming fan-out

A webhook-started run streams exactly like a manual one. The route hands the
dispatch-owned `broadcastToConversationSubscribers` /
`broadcastToTaskSubscribers` helpers (off `req.app.locals`) into the trigger,
which wraps the former into the `BroadcastFn(convId, msg)` shape the conversation
lifecycle expects (`createBroadcastFn` in `webhookService.ts`). Anyone watching
that task in the UI sees the agent work live, with no special-casing.

## What to build

- [ ] A router at `/api/webhooks` with `POST /github` and `GET /health`,
      mounted with a **raw** body parser **before** JSON parsing.
- [ ] HMAC-SHA256 signature verification against the raw bytes using
      `GITHUB_WEBHOOK_SECRET`, constant-time compare, `401` on failure.
- [ ] Event/action/PR filtering and the `@<trigger>` mention gate, with the
      trigger read from `app_settings.github_pr_trigger`.
- [ ] PR→task mapping: branch from payload (review) or `gh pr view` (comment),
      then `task/{id}-…` parse.
- [ ] Inline-comment fetch for reviews via `gh api …/reviews/{id}/comments`.
- [ ] Two trigger functions that run the precondition guards and call
      `startAgentRun(taskId, 'pr', { webhookContext, userId: taskOwner.id })`
      with the right context shape (review carries `comments`).
- [ ] In the `pr` branch of `startAgentRun`, select review vs comment vs plain
      prompt from the presence/shape of `webhookContext`.
- [ ] Two feedback-prompt builders rendering the shared `pr-feedback.md`.
- [ ] Map "not ready" trigger errors to `200 ignored`; everything else `500`.

## Reference map

| Concern | File |
|---|---|
| Route, event filtering, branch/PR fetch, inline-comment fetch | `reference/server/routes/webhooks.ts` |
| HMAC verify, trigger-mention, branch parse, the two trigger fns, broadcast wrap | `reference/server/services/webhookService.ts` |
| `webhookContext` branch + prompt selection | `reference/server/services/agentRunner.ts` (`startAgentRun`, `pr` case) |
| Feedback prompt builders | `reference/server/constants/agentPrompts.ts` (`generatePrAgentCommentMessage`, `generatePrAgentReviewMessage`) |
| Shared feedback prompt template | `reference/server/constants/prompts/pr-feedback.md` |
| Raw-body mount ordering | `reference/server/index.ts` (`app.use('/api/webhooks', express.raw…)`) |

## Boundaries (not in this spec)

- The PR agent's actual create/CI/conflict/completion procedure →
  [`pull-request-agent.md`](../core/pull-request-agent.md).
- The state machine, the "one running agent per task" rail, and why PR is
  terminal → [`orchestration-loop.md`](../core/orchestration-loop.md).
- The `task/{id}-{slug}` branch convention this depends on →
  [`task-and-workspace.md`](../core/task-and-workspace.md).
- Per-user provider/model/credential resolution the run-as-owner step relies on
  → [`prompt-and-model-customization.md`](./prompt-and-model-customization.md).
