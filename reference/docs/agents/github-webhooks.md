# GitHub webhooks — re-entering the loop from PR comments & reviews

How a `@`-mention on a GitHub PR re-triggers the PR agent. This is the inbound
half of the loop; the agent it starts is the same `pr` agent from
[`agentic-loop.md`](./agentic-loop.md).

## The endpoint & the raw-body requirement

`POST /api/webhooks/github` (`server/routes/webhooks.ts:101`). HMAC signature
validation needs the **raw bytes**, so the route is mounted with
`express.raw({ type: 'application/json' })` **before** `express.json()`
(`server/index.ts:184` — order is load-bearing). `validateGitHubWebhookSignature`
(`server/services/webhookService.ts:21`) computes `HMAC-SHA256` over the raw body
with `GITHUB_WEBHOOK_SECRET` and compares via `crypto.timingSafeEqual`; a mismatch
is `401`. `GET /api/webhooks/health` reports whether the secret is configured.

## What it listens for

Only two events, each gated to one action:
- **`issue_comment` / `created`** — a comment on a PR (ignored if not on a PR).
- **`pull_request_review` / `submitted`** — a submitted review (body + inline
  comments fetched via `gh api`).

## The configurable @-trigger

`getConfiguredTrigger()` (`webhookService.ts:58`) reads
`app_settings.github_pr_trigger` (default `bottega`), editable from the UI — so an
instance picks its own mention (`@bottega`, `@jarvis`, …). `hasTriggerMention`
checks the comment/review body (and review's inline comments) for it; no match →
`200 {status:'ignored'}`. Webhooks **always 200 on a benign no-op** so GitHub
doesn't mark the delivery failed.

## branch → owner → re-entry

The PR's branch name is parsed back to whoever owns it by `resolveBranchOwner`
(`routes/webhooks.ts`), which tries two anchored parsers in order:

- **`parseTaskIdFromBranch`** (`webhookService.ts:45`) — the inverse of the
  `task/{id}-…` naming from [`worktrees-and-pr.md`](./worktrees-and-pr.md).
  With a task id the route calls `triggerPrAgentFromComment` /
  `triggerPrAgentFromReview`, which `startAgentRun(taskId, 'pr', {
  webhookContext })` — the comment/review text flows into the PR agent's prompt
  (`generatePrAgentCommentMessage` / `generatePrAgentReviewMessage`).
- **`parseEpicIdFromBranch`** (`webhookService.ts:65`) — `epic/{id}-…`, the
  epic's feature branch, i.e. a comment on the **final pull request**. It
  routes to `triggerEpicDeliveryFrom{Comment,Review}` and the epic's delivery
  agent; see [`../epics/delivery.md`](../epics/delivery.md).

Both are anchored, so a branch resolves to a task, to an epic, or to neither —
never both. A branch nobody owns answers `200 {status:'ignored'}`.

`respondToTriggerFailure` is the single place a failed trigger becomes a
response. "already running" / "already completed" / "No worktree" / "not found"
/ "has no feature branch" / "has no owning user", plus a missing provider
credential or agent-model setting, all downgrade to `200 ignored`: a 500 makes
GitHub retry, and the retry lands in the same state. A `BaseSyncConflictError`
answers `200 {status:'blocked'}` — the run is already failed and the task
blocked.

## gh-CLI injection guards

Everything shelling out to `gh` uses the `execFile`-only `runCommand`
(`server/services/shell.ts` — no `shell: true`, so arguments can't be
re-interpreted). On top of that, untrusted values from the payload are validated
before they reach an argv: `assertValidPositiveInt` (PR/review ids) and
`assertValidRepoFullName` (`owner/repo` shape) from
`server/services/validators.ts` — defense in depth, since `execFile` already keeps
shell metacharacters inert.

## Key files

- `server/routes/webhooks.ts` — `POST /github`, `resolveBranchOwner`, `respondToTriggerFailure`, `/health`.
- `server/index.ts:184` — the raw-body mount (before `express.json`).
- `server/services/webhookService.ts:21` — signature; `:45` `parseTaskIdFromBranch`; `:65` `parseEpicIdFromBranch`; `getConfiguredTrigger`; `triggerPrAgentFrom{Comment,Review}`.
- `server/services/epics/deliveryWebhook.ts` — the epic half, `triggerEpicDeliveryFrom{Comment,Review}`.
- `server/constants/prFeedback.ts` — comment/review quoting, shared by both agents.
- `server/services/validators.ts` — the `assertValid*` argv guards.
- `server/services/shell.ts` — `runCommand` (`execFile`, no shell).
