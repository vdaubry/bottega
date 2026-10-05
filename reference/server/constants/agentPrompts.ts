/**
 * Agent Prompt Generators (Server-Side)
 *
 * Each generator loads a markdown template (with optional user override at
 * ~/.bottega/prompts/{name}.md), pre-builds any dynamic sections (loops,
 * conditionals) in JS, then injects them via {{var}} substitution. Edit the
 * markdown templates in server/constants/prompts/ — or via the Settings UI —
 * to change agent behavior without touching code.
 */

import { getScriptsDir, loadPrompt, renderPrompt, resolvePromptPath } from '../services/promptRenderer.js';
import {
  buildCommentFeedbackSection,
  buildReviewFeedbackSection,
  type CommentWebhookContext,
  type ReviewWebhookContext,
} from './prFeedback.js';

/**
 * Pre-rendered {{prPublishBlock}} — the opening step of the PR/CI procedure
 * inlined into pr.md and yolo.md: get *every* change in this worktree onto the
 * PR, then prove it landed.
 *
 * **Both states run the same publish procedure; only the last sub-step differs**
 * (create the PR, or let the push update the one that is already open). This
 * block used to branch much earlier — into "create a PR" vs "a PR already exists
 * at …, skip to step 2" — and that second path contained no check for
 * unpublished work at all. It only has to be taken once for work to be lost: a
 * project whose CLAUDE.md tells every agent to open a PR gets one from the
 * implementation agent, so by the time the PR stage runs the PR exists, the
 * agent skips straight to mergeability and CI, and signs the task off against a
 * commit that predates everything review and refinement wrote. Those two stages
 * deliberately do not commit (see review.md / refinement.md) — publishing their
 * edits is this stage's job — so their work sat in the worktree and would have
 * died with it.
 *
 * `baseBranch` is the branch this task's PR targets: the repo's default branch
 * for a standalone ticket, the epic's feature branch for an epic ticket. It is
 * resolved by the caller (never assumed to be `main`).
 */
function buildPrPublishBlock(
  taskId: number,
  prUrl: string | null | undefined,
  baseBranch: string,
): string {
  const pushStep = prUrl
    ? `4. **Push — that is how you update the open PR.** The PR is at ${prUrl}; there is nothing to create, and pushing this branch *is* the update:
   \`\`\`bash
   git push -u origin HEAD
   \`\`\`
   If what you just pushed makes the PR's title or body wrong, correct them with \`gh pr edit\`.`
    : `4. **Push and open the PR.** First confirm there is something to submit:
   \`\`\`bash
   git log --oneline origin/${baseBranch}..HEAD
   \`\`\`
   - **No commits ahead** — there is nothing to submit. Run the completion script and stop:
     \`\`\`bash
     tsx ${getScriptsDir()}/complete-pr.ts ${taskId}
     \`\`\`
   - Otherwise push, then create the PR against \`${baseBranch}\` with a short specific title and concise summary body. Replace the placeholders with the actual task title and implementation summary:
     \`\`\`bash
     git push -u origin HEAD
     gh pr create --base ${baseBranch} --title "<short task title>" --body "Summary: <what the task does and how this implementation solves it. Keep this to a short paragraph. Task: #${taskId}>"
     \`\`\``;

  return `### 1. Publish Every Change In This Worktree

This worktree is disposable: once the PR merges it is deleted, and anything in it
that never reached the PR is lost with it. The stages that ran before you edit
files and deliberately do not commit — their work is sitting here unpublished
right now. Publishing it is your job, and it is the same job whether or not a PR
already exists. **An existing PR is never evidence that the work is in it.**

1. **Inventory what is unpublished** — both kinds, every time:
   \`\`\`bash
   git status --porcelain --untracked-files=all
   git log --oneline HEAD --not --remotes=origin
   \`\`\`
   The second one is the easy one to miss: commits that never left this box are
   not part of the merge and die with the worktree, on a tree that reports
   perfectly clean.

2. **Triage every path \`git status\` listed — keep it or delete it.**
   - **Keep** what belongs in the change: source, tests, docs, the task documentation.
   - **Delete** what was only scaffolding for getting here: QA screenshots and
     recordings, Playwright traces and reports, log files, coverage output,
     scratch or one-off scripts, \`*.bak\` copies, sample data you generated to try
     something out. \`rm\` them — do not commit them, and do not hide them behind a
     new \`.gitignore\` entry. The worktree has to be *empty* of them, not just
     quiet about them.

   If a file is genuinely ambiguous, ask whether a reviewer would want it in the
   diff. If not, it goes.

3. **Commit what is left:**
   \`\`\`bash
   git add -A && git commit -m "<concise description of the change>"
   \`\`\`
   A clean tree after the triage is a valid outcome — carry on.

${pushStep}

5. **Confirm the push actually landed.** A merge takes the PR's *remote* head, so
   that head has to be the commit you just made:
   \`\`\`bash
   git rev-parse HEAD
   gh pr view --json headRefOid --jq .headRefOid
   \`\`\`
   Those two must match, and step 1's two commands must now both come back empty.
   If any of that is not true, go back to step 2 — do **not** move on to CI, or
   the checks you are about to approve will be for a commit that is missing work.`;
}

/**
 * Pre-rendered {{sensitiveAreasSection}} for the non-technical planification
 * prompt: the project's "sensitive areas" list (`projects.sensitive_areas`,
 * edited on the project form) wrapped in the escalation protocol.
 * Deterministically empty when the list is blank — the guardrail is then
 * absent from the prompt altogether rather than left to the agent's judgment.
 */
function buildSensitiveAreasSection(
  taskId: number,
  sensitiveAreas: string | null | undefined,
): string {
  const list = sensitiveAreas?.trim() ?? '';
  if (!list) return '';
  return renderPrompt('planification-sensitive-areas', { sensitiveAreas: list, taskId });
}

export async function generatePlanificationMessage(
  taskDocPath: string,
  taskId: number,
  isTechnical: boolean = true,
  sensitiveAreas: string | null = null,
): Promise<string> {
  const promptName = isTechnical ? 'planification' : 'planification-nontechnical';
  // The template is inlined as content, never @-referenced by path: an @-file
  // mention makes the Claude Agent SDK pull the referenced file's containing
  // project CLAUDE.md (i.e. Bottega's own docs) into the target repo's context.
  const planTemplate = loadPrompt('plan-template');
  // Legacy: pre-inlining operator overrides of the planification prompts may
  // still reference {{planTemplatePath}}; keep providing it so they render.
  const planTemplatePath = resolvePromptPath('plan-template');
  const vars: Record<string, unknown> = { taskDocPath, taskId, planTemplate, planTemplatePath };
  // The guardrail exists for the user who cannot review the plan before
  // implementation starts; the technical prompt never carries it.
  if (!isTechnical) {
    vars.sensitiveAreasSection = buildSensitiveAreasSection(taskId, sensitiveAreas);
  }
  return renderPrompt(promptName, vars);
}

export async function generateImplementationMessage(
  taskDocPath: string,
  taskId: number,
): Promise<string> {
  return renderPrompt('implementation', { taskDocPath, taskId });
}

export async function generateReviewMessage(taskDocPath: string, taskId: number): Promise<string> {
  return renderPrompt('review', { taskDocPath, taskId });
}

export async function generateRefinementMessage(
  taskDocPath: string,
  taskId: number,
  baseBranch: string,
): Promise<string> {
  return renderPrompt('refinement', { taskDocPath, taskId, baseBranch });
}

export async function generatePrAgentMessage(
  taskDocPath: string,
  taskId: number,
  prUrl: string | null | undefined,
  baseBranch: string,
): Promise<string> {
  const prContextLine = prUrl
    ? `- Existing PR: ${prUrl} — publish this worktree's work to it (see step 1)`
    : '- No PR exists yet - you need to create one';
  const prPublishBlock = buildPrPublishBlock(taskId, prUrl, baseBranch);
  return renderPrompt('pr', {
    taskDocPath,
    taskId,
    prContextLine,
    prPublishBlock,
    // Legacy: operator overrides written before the block became state-agnostic
    // still say {{prCreateOrVerifyBlock}}; keep feeding them the same text so
    // they render (stale, but rendering) instead of throwing on a missing var.
    prCreateOrVerifyBlock: prPublishBlock,
    baseBranch,
  });
}

export async function generateYoloMessage(
  taskDocPath: string,
  taskId: number,
  prUrl: string | null | undefined,
  baseBranch: string,
): Promise<string> {
  const prContextLine = prUrl
    ? `- Existing PR: ${prUrl} — publish this worktree's work to it in Phase 5`
    : '- No PR exists yet - you will create one at the end';
  const prPublishBlock = buildPrPublishBlock(taskId, prUrl, baseBranch);
  return renderPrompt('yolo', {
    taskDocPath,
    taskId,
    prContextLine,
    prPublishBlock,
    // See generatePrAgentMessage: legacy alias for pre-rename overrides.
    prCreateOrVerifyBlock: prPublishBlock,
    baseBranch,
  });
}

export async function generatePrAgentCommentMessage(
  taskDocPath: string,
  taskId: number,
  prUrl: string | null | undefined,
  webhookContext: CommentWebhookContext,
  baseBranch: string,
): Promise<string> {
  return renderPrompt('pr-feedback', {
    taskDocPath,
    taskId,
    prUrl,
    feedbackSection: buildCommentFeedbackSection(webhookContext),
    baseBranch,
  });
}

export async function generatePrAgentReviewMessage(
  taskDocPath: string,
  taskId: number,
  prUrl: string | null | undefined,
  webhookContext: ReviewWebhookContext,
  baseBranch: string,
): Promise<string> {
  return renderPrompt('pr-feedback', {
    taskDocPath,
    taskId,
    prUrl,
    feedbackSection: buildReviewFeedbackSection(webhookContext),
    baseBranch,
  });
}

/**
 * Agent type identifiers
 */
export const AGENT_TYPE = {
  PLANIFICATION: 'planification',
  IMPLEMENTATION: 'implementation',
  REFINEMENT: 'refinement',
  REVIEW: 'review',
  PR: 'pr',
} as const;
