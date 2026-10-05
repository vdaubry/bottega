/**
 * Code-Delivery Pipeline
 * ----------------------
 * An autonomous, sequential coding pipeline that turns a plan into a pull
 * request. It reproduces Bottega's own agent chain — implement ⇄ review →
 * refine → PR — driven entirely by the plan file that `/planification` wrote.
 *
 *   preflight ─▶ IMPLEMENTER ─▶ ( REVIEWER ⇄ IMPLEMENTER ) ─▶ REFINER ─▶ PR-MANAGER
 *
 * The plan path is computed deterministically from the current git branch
 * (`git branch --show-current` → leaf → `tmp/plans/<leaf>.md`, falling back to
 * `tmp/plans/plan.md` when detached). **If the plan does not exist, the
 * pipeline refuses to start.**
 *
 * Each stage's prompt is adapted from `reference/server/constants/prompts/*`:
 *   IMPLEMENTER ← implementation.md (+ yolo.md phase 2)
 *   REVIEWER    ← review.md
 *   REFINER     ← refinement.md
 *   PR-MANAGER  ← pr.md
 * Retargeted from Bottega's `{{taskDocPath}}`/`{{taskId}}` model to a plain
 * plan file on a git branch, with all DB-coupled bits removed: the
 * `complete-*.ts` / `block-*.ts` completion scripts, task IDs, and the
 * Playwright video tool (it writes to a DB-controlled output path). QA evidence
 * is captured with plain screenshots instead. Verdict status (READY /
 * NEEDS_WORK / BLOCKED) drives the loop in place of the completion scripts.
 *
 * Run it with the Workflow tool: `Workflow({ name: 'code-delivery' })`.
 */

export const meta = {
  name: 'code-delivery',
  description:
    'Autonomous code-delivery pipeline: implement → review (loop) → refine → open PR, driven by the deterministic plan file from /planification. Refuses to start if no plan exists.',
  whenToUse:
    'After /planification has produced tmp/plans/<branch-leaf>.md and you want the change implemented, reviewed, refined, and turned into a PR with no further input.',
  phases: [
    { title: 'Preflight', detail: 'resolve the plan path and refuse to start if it is missing' },
    { title: 'Implement', detail: 'implement every unchecked to-do item and commit' },
    { title: 'Review', detail: 'verify the checklist, run tests + QA, loop back on failure' },
    { title: 'Refine', detail: 'simplification + security review, apply fixes' },
    { title: 'PR', detail: 'push the branch, open the PR, drive CI to green' },
  ],
}

// How many implement⇄review rounds before we give up and report instead of
// looping forever. Round 1 is the initial review; each NEEDS_WORK sends work
// back to the implementer and re-reviews.
const MAX_REVIEW_ITERATIONS = 3

// ---------------------------------------------------------------------------
// Structured-output schemas (force agents to return validated data)
// ---------------------------------------------------------------------------

const PREFLIGHT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['planExists', 'planPath', 'branch'],
  properties: {
    planExists: { type: 'boolean' },
    planPath: { type: 'string', description: 'The deterministic plan path that was resolved' },
    branch: { type: 'string' },
    baseBranch: { type: 'string', description: 'PR base branch, e.g. main' },
    uncheckedTodoCount: { type: 'integer' },
    summary: { type: 'string', description: 'One-line description of what the plan delivers' },
  },
}

const IMPLEMENTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['committed', 'summary'],
  properties: {
    committed: { type: 'boolean' },
    commitMessage: { type: 'string' },
    remainingUnchecked: { type: 'integer' },
    summary: { type: 'string' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary'],
  properties: {
    status: { enum: ['READY', 'NEEDS_WORK', 'BLOCKED'] },
    checklist: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'verdict'],
        properties: {
          item: { type: 'string' },
          verdict: { enum: ['VERIFIED', 'FAILED'] },
          reason: { type: 'string' },
        },
      },
    },
    unitTests: {
      type: 'object',
      additionalProperties: false,
      required: ['result'],
      properties: { result: { enum: ['PASS', 'FAIL', 'NOT_RUN'] }, details: { type: 'string' } },
    },
    qa: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['scenario', 'result'],
        properties: {
          scenario: { type: 'string' },
          result: { enum: ['PASS', 'FAIL', 'BLOCKED'] },
          details: { type: 'string' },
        },
      },
    },
    issues: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

const REFINER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['committed', 'summary'],
  properties: {
    simplifications: { type: 'integer' },
    securityFixes: { type: 'integer' },
    files: { type: 'array', items: { type: 'string' } },
    committed: { type: 'boolean' },
    summary: { type: 'string' },
  },
}

const PR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pushed', 'summary'],
  properties: {
    pushed: { type: 'boolean' },
    prUrl: { type: ['string', 'null'] },
    ciStatus: { type: 'string', description: 'PASSED | FAILED | PENDING | UNKNOWN' },
    summary: { type: 'string' },
  },
}

// ---------------------------------------------------------------------------
// Adapted agent prompts
// ---------------------------------------------------------------------------

const preflightPrompt = `You are the PREFLIGHT step of an autonomous code-delivery pipeline. Do READ-ONLY discovery — do not modify any file, do not commit, and do not change branches. (A \`git fetch\` to refresh remote-tracking refs is fine.)

## Resolve the plan path (deterministic — one plan per worktree/branch)
Run exactly this and use the printed path as <plan-path>:
\`\`\`bash
leaf="$(git branch --show-current 2>/dev/null | sed 's#.*/##')"
[ -z "$leaf" ] && leaf="plan"
echo "tmp/plans/\${leaf}.md"
\`\`\`

## Gather facts
1. Does <plan-path> exist? (\`test -f <plan-path> && echo yes\`)
2. The current branch name (\`git branch --show-current\`). **If HEAD is detached this is empty — report \`branch\` as an empty string** (the pipeline then refuses to start, because committing and opening a PR both need a branch).
3. The PR base branch: prefer the remote default (\`git symbolic-ref --quiet refs/remotes/origin/HEAD | sed 's#.*/##'\`); if that is empty, use \`main\`. Then refresh it so later diffs are current: \`git fetch origin <baseBranch> --quiet || true\`.
4. If the plan exists: read it and count the still-unchecked To-Do items (lines matching \`- [ ]\`). Write a one-line summary of what the plan delivers.

Return the structured result. Set planExists=false if the plan file is absent, and report an empty \`branch\` if HEAD is detached — the pipeline refuses to start in either case.`

function implementerPrompt(planPath, isFixPass) {
  return `You are the IMPLEMENTER agent in an autonomous code-delivery pipeline.

Plan file: \`${planPath}\` — produced by /planification. Follow it exactly.

## Your job
1. Read the plan file in full.
2. ${
    isFixPass
      ? 'A previous review found problems. Read the "## Review Findings" section of the plan FIRST and fix every issue it lists before anything else. The reviewer un-checked ([ ]) the specific To-Do items that failed — those are your priority.'
      : 'This is the first implementation pass.'
  }
3. Implement every unchecked ([ ]) item in the To-Do List (both the Implementation and Testing sections), working through the plan's phases in order.
4. Mark each item complete ([x]) in the plan file as you finish it. Only check a **Testing** To-Do item after you have actually run that test/QA step and seen it pass — never check a box for an unexecuted or failing step.
5. Add or update unit tests for the code you change — the plan's Testing Strategy is mandatory, not optional.

## Constraints
- Do NOT ask questions — proceed autonomously and state assumptions in your commit/summary.
- Stay in scope: build exactly what the plan asks for. No speculative abstractions, no unrelated refactors, no fallbacks for states that cannot happen.
- Work only on the current branch and worktree — never switch branches.
- This repo is TypeScript-only: never add \`.js\`/\`.jsx\` source files.
- Do NOT push or open a PR — later pipeline stages own that.

## Commit (required)
When the unchecked items are done, commit on the current branch:
\`git add -A && git commit -m "<concise message describing what you implemented>"\`
(If this was a fix pass driven by Review Findings, say so in the message.)

Return the structured result: whether you committed, the commit message, and how many To-Do items remain unchecked.`
}

function reviewerPrompt(planPath) {
  return `You are the REVIEWER agent in an autonomous code-delivery pipeline. You verify the implementation against the plan and decide whether it is ready. You do NOT fix code — you only review, test, and record findings.

Plan file: \`${planPath}\`.

## 1. Read the plan
Understand what was to be built, the Testing Strategy, and which To-Do items are checked ([x]).

### Early return — still in progress
If ANY To-Do item is still unchecked ([ ]): do NOT run tests. Set status = NEEDS_WORK, list the unchecked items as issues, replace the plan's "## Review Findings" section with a short IN_PROGRESS note, and return.

## 2. Verify checked items against the plan (STRICT matching)
Implementation agents cut corners — marking items done when the work is partial. For EVERY checked ([x]) item, confirm the real artifact exists and matches the plan: a file the plan says to create actually exists with the described contents; a "move X to Y" actually removed X; an added method has the expected signature. Apply strict matching, not spirit matching — do not rationalize deviations. Record VERIFIED or FAILED (with reason) per item. Any FAILED item ⇒ NEEDS_WORK regardless of test results.

## 3. Run unit tests
Run targeted tests for the changed files first, then the full suite (use the project's test command from CLAUDE.md — e.g. \`pnpm test:run\`; run long suites in the background and wait for them to finish before re-running). Report PASS/FAIL with the failures.

## 4. QA — run the Testing Strategy's manual checks
Every QA scenario in the plan's Testing Strategy is MANDATORY: each is PASS, FAIL, or BLOCKED — never "skipped". Use the right tool per scenario (Playwright MCP for UI flows, \`curl\` for HTTP endpoints, DB inspection, a background job, etc.). For UI scenarios, capture a screenshot as evidence and cite it in the QA details.
**Live model conversations are normal, expected QA — run them; do not skip or BLOCK them.** Many features (especially in an AI product) can only be honestly validated by driving the real thing end-to-end: start a dev server and use Playwright MCP to open a conversation and send a live query/prompt to the model or agent, then observe the actual result. This legitimately spins up a dev server, consumes model quota, and creates real conversations/data — that is the expected cost of QA, not a reason to avoid it. Do it whenever it is the truthful way to confirm the work, and budget for the wait (a live generation can take several minutes — poll for completion in the background rather than giving up). A live run is NOT an "inaccessible resource"; needing one is never, by itself, grounds for BLOCKED.
**Server isolation (CRITICAL):** never reuse or stop a server you did not start. If a scenario needs the running app, start YOUR OWN dev server on a free port from THIS worktree, test against it, and kill it by port when done (\`lsof -ti:<port> | xargs kill -9\`). Never restart the shared/systemd service, and never run \`pnpm install\` inside the worktree. If the dev server's proxy/transport looks broken (e.g. a WebSocket that won't connect, or requests hitting the wrong backend), suspect your own port/config wiring first and fix it — don't conclude the feature is broken or untestable.

## 5. Verdict
- READY — all unit tests pass, all QA scenarios pass, every checked item VERIFIED, and all To-Do items are checked.
- NEEDS_WORK — any failed verification, test failure, QA failure, or still-unchecked item.
- BLOCKED — every agent-actionable step is done, but a remaining item genuinely needs a user decision or a resource you truly cannot reach (a credential this machine does not have, a third-party system you cannot call). This is a HIGH bar: before recording BLOCKED on a QA scenario you MUST have actually attempted it on your own dev server. "Needs a live model conversation", "needs a dev server", "needs model quota", or "needs the canonical/production box" do NOT qualify — those are accessible here, so attempt them. Prefer FAIL (or fixing your own test setup) over a premature BLOCKED.

## 6. Record findings in the plan file
REPLACE (never append to) the plan's "## Review Findings" section with the current results only — status, per-item checklist verdicts, unit-test result, QA results, and the concrete issues to address. If NEEDS_WORK, also un-check ([ ]) the specific failed To-Do items so the implementer retries exactly those.

Do NOT modify code. Do NOT run any completion/block scripts. Return the structured verdict.`
}

function simplifyPrompt(baseBranch) {
  return `You are a code-simplification agent (refinement stage). Review the code modified on this branch and simplify it for clarity, consistency, and maintainability — WITHOUT changing behavior.

## Process
1. Run \`git fetch origin ${baseBranch} --quiet\` so the base ref is current, then \`git diff origin/${baseBranch} --name-only\` to list the files modified on this branch.
2. Read each modified file.
3. Simplify: remove needless complexity, improve naming, reduce duplication, simplify conditionals, improve organization. Follow the standards in CLAUDE.md.
4. Apply the fixes directly to the working tree.

## Constraints
- Only touch files changed on this branch. Do NOT modify test files unless they have an obvious bug. Do NOT modify the plan file.
- Preserve all functionality; keep changes minimal and focused.
- Do NOT commit and do NOT push — the refinement apply step commits.

Return a one-line summary of the simplifications you made (or "no simplifications needed").`
}

function securityPrompt(baseBranch) {
  return `You are a security-review agent (refinement stage). Analyze this branch's changes for vulnerabilities. READ-ONLY — modify nothing.

## Inputs
\`git diff origin/${baseBranch}\`, \`git status\`, \`git log origin/${baseBranch}..HEAD --oneline\`.

## Three-phase analysis
1. Context: what the code does, its trust boundaries, data flows, and attack surface.
2. Comparative: changes vs. security best practices and common patterns (OWASP Top 10).
3. Assessment: per finding give severity (HIGH/MEDIUM/LOW), confidence (1–10), exploitability, and a specific recommended fix.

## Output (markdown report)
- Summary of changes reviewed.
- Findings — HIGH/MEDIUM only, confidence ≥ 8 — each with file, line, description, severity, confidence, and the exact recommended fix.
- If no high-confidence vulnerabilities exist, say so explicitly.
Focus on high-confidence issues only; do not report speculative or low-severity items. Do NOT modify files.`
}

function refineApplyPrompt(simplifySummary, securityReport, baseBranch) {
  return `You are the refinement APPLY + COMMIT agent. A simplification pass and a security review just ran on this branch's changes.

Simplification summary:
---
${simplifySummary}
---
Security review report:
---
${securityReport}
---

## Steps
1. For each HIGH or MEDIUM security finding with confidence ≥ 8: read the affected file and apply the recommended fix. If there are none, skip.
2. Commit ALL refinement changes on the current branch — the simplifications already in the working tree plus your security fixes:
   \`git add -A && git commit -m "Refine: simplifications + security fixes"\`
   If \`git status\` shows nothing to commit, skip the commit.

## Constraints
- Do NOT modify the plan file. Do NOT run tests (the PR stage runs CI). Do NOT push.

Return counts of simplifications and security fixes applied, the files touched, whether you committed, and a one-line summary. Use \`git diff origin/${baseBranch} --name-only\` if you need the file list.`
}

function prManagerPrompt(planPath, baseBranch, reviewSummary, refineSummary) {
  return `You are the PR-MANAGER agent. Push the branch, open a pull request, and shepherd CI to green. Do NOT merge — the user merges manually.

Plan file: \`${planPath}\`. Base branch: \`${baseBranch}\`.

## 1. Create the PR
1. \`git status\` — commit any leftover changes with a concise message.
2. Confirm there are commits ahead of the base: \`git log origin/${baseBranch}..HEAD --oneline\`. If nothing is ahead and nothing is uncommitted, there is nothing to submit — report that and stop.
3. Push: \`git push -u origin $(git branch --show-current)\`.
4. Open the PR with a clear, specific title and a body that summarizes:
   - open with a one-paragraph **Summary** drawn from the plan's \`## Overview\` (keep it short),
   - the key changes made,
   - the review & QA results,
   - the refinement results.
   \`gh pr create --title "<short title>" --body "<summary>"\`
   Fold this pipeline context into the body:
   - Review: ${reviewSummary}
   - Refinement: ${refineSummary}

## 2. Monitor CI
\`gh pr checks\`. If PENDING, poll (\`sleep 30\`, up to ~20 times).

## 3. Handle CI results
If FAILED: get details (\`gh pr checks\`, \`gh run view <run-id> --log-failed\`), fix the cause in code, \`git add -A && git commit -m "Fix CI: <description>" && git push\`, then re-check (max 10 iterations). If it still fails, document the persistent failures and stop.

## 4. Merge conflicts
When CI passes: \`gh pr view --json mergeStateStatus,mergeable\`. If CONFLICTING, rebase onto origin/${baseBranch}, resolve, \`git push --force-with-lease\`, and re-check CI (max 3 attempts). If UNKNOWN, wait 10s and retry (up to 5 times).

## Constraints
- Do NOT merge the PR. Do NOT run any completion scripts — this is a standalone pipeline, not Bottega's DB-backed workflow.

Return whether you pushed, the PR URL, the final CI status, and a one-line summary.`
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

phase('Preflight')
const pre = await agent(preflightPrompt, {
  label: 'preflight',
  phase: 'Preflight',
  schema: PREFLIGHT_SCHEMA,
})

if (!pre || !pre.planExists) {
  const where = pre && pre.planPath ? ` (expected at ${pre.planPath})` : ''
  log(`No plan file found${where} — the pipeline will not start. Run /planification first.`)
  return { started: false, reason: 'missing-plan', planPath: (pre && pre.planPath) || null }
}

if (!pre.branch || !pre.branch.trim()) {
  log(`HEAD is detached (no branch) — committing and opening a PR both need a branch. Check out a branch and re-run.`)
  return { started: false, reason: 'detached-head', planPath: pre.planPath }
}

const base = pre.baseBranch || 'main'
log(
  `Plan found at ${pre.planPath} on branch ${pre.branch} → base ${base}. ` +
    `${pre.uncheckedTodoCount ?? '?'} unchecked to-do item(s). ${pre.summary || ''}`,
)

phase('Implement')
let impl = await agent(implementerPrompt(pre.planPath, false), {
  label: 'implementer',
  phase: 'Implement',
  schema: IMPLEMENTER_SCHEMA,
})
log(
  `Implementer: ${impl && impl.committed ? 'committed' : 'no commit reported'}; ` +
    `${impl && impl.remainingUnchecked != null ? impl.remainingUnchecked : '?'} to-do item(s) still unchecked.`,
)

phase('Review')
let review = null
let iterations = 0
while (iterations < MAX_REVIEW_ITERATIONS) {
  iterations++
  review = await agent(reviewerPrompt(pre.planPath), {
    label: `reviewer#${iterations}`,
    phase: 'Review',
    schema: REVIEW_SCHEMA,
  })
  if (!review || review.status !== 'NEEDS_WORK') break
  // Only spend a fix-pass if another review will follow it — otherwise we'd
  // commit an unvalidated fix on the very last iteration and never re-review.
  if (iterations >= MAX_REVIEW_ITERATIONS) {
    log(`Review #${iterations}: NEEDS_WORK, but the review budget is exhausted — stopping without another fix pass.`)
    break
  }
  log(
    `Review #${iterations}: NEEDS_WORK — looping back to the implementer. ` +
      `Issues: ${(review.issues || []).join('; ') || '(see plan Review Findings)'}`,
  )
  impl = await agent(implementerPrompt(pre.planPath, true), {
    label: `implementer-fix#${iterations}`,
    phase: 'Implement',
    schema: IMPLEMENTER_SCHEMA,
  })
}

if (!review || review.status !== 'READY') {
  log(
    `Stopping before refine/PR — review status is ${review ? review.status : 'UNKNOWN'} ` +
      `after ${iterations} iteration(s). Inspect the plan's Review Findings.`,
  )
  return {
    started: true,
    planPath: pre.planPath,
    branch: pre.branch,
    reviewStatus: review ? review.status : 'UNKNOWN',
    iterations,
    issues: review ? review.issues || [] : [],
    prUrl: null,
  }
}

phase('Refine')
// Sequence simplify → security: simplify WRITES to the working tree, so the
// security review must analyze the settled tree rather than race the rewrite.
const simplifySummary = await agent(simplifyPrompt(base), { label: 'refine:simplify', phase: 'Refine' })
const securityReport = await agent(securityPrompt(base), { label: 'refine:security', phase: 'Refine' })
const refine = await agent(
  refineApplyPrompt(simplifySummary || '(no simplification summary)', securityReport || '(no security report)', base),
  { label: 'refine:apply+commit', phase: 'Refine', schema: REFINER_SCHEMA },
)

phase('PR')
const pr = await agent(
  prManagerPrompt(pre.planPath, base, review.summary || 'see plan Review Findings', (refine && refine.summary) || 'no refinement changes'),
  { label: 'pr-manager', phase: 'PR', schema: PR_SCHEMA },
)

log(`Pipeline complete. PR: ${(pr && pr.prUrl) || '(none)'} — CI ${(pr && pr.ciStatus) || 'unknown'}.`)
return {
  started: true,
  planPath: pre.planPath,
  branch: pre.branch,
  reviewStatus: 'READY',
  iterations,
  refiner: refine,
  prUrl: (pr && pr.prUrl) || null,
  ciStatus: (pr && pr.ciStatus) || null,
}
