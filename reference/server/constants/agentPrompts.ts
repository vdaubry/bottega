/**
 * Agent Prompt Generators (Server-Side)
 *
 * Each generator loads a markdown template (with optional user override at
 * ~/.bottega/prompts/{name}.md), pre-builds any dynamic sections (loops,
 * conditionals) in JS, then injects them via {{var}} substitution. Edit the
 * markdown templates in server/constants/prompts/ — or via the Settings UI —
 * to change agent behavior without touching code.
 */

import { renderPrompt, resolvePromptPath } from '../services/promptRenderer.js';

interface FileContext {
  path?: string;
  line?: number | null;
  startLine?: number | null;
  diffHunk?: string | null;
  side?: string | null;
}

interface CommentWebhookContext {
  commentBody?: string;
  commentAuthor?: string;
  fileContext?: FileContext | null;
}

interface ReviewComment {
  commentBody?: string;
  commentAuthor?: string;
  fileContext?: FileContext | null;
}

interface ReviewWebhookContext {
  reviewBody?: string | null;
  reviewAuthor?: string;
  comments?: ReviewComment[];
}

/**
 * Pre-rendered {{prCreateOrVerifyBlock}} — the "create a new PR" vs "verify the
 * existing PR" opening step of the PR/CI procedure inlined into pr.md and yolo.md.
 */
function buildPrCreateOrVerifyBlock(taskId: number, prUrl: string | null | undefined): string {
  if (prUrl) {
    return `### 1. Verify PR Exists
A PR already exists at ${prUrl}. Skip to step 2.`;
  }
  return `### 1. Create PR
Create a PR for this task:
1. Check for uncommitted changes: \`git status\`
2. If changes exist, commit them with a concise message describing the task: \`git add -A && git commit -m "Implement <short task title>"\`
3. Verify there are commits ahead of the base branch: \`git log origin/main..HEAD --oneline\`
   - **If no commits ahead** (and no uncommitted changes were found in step 1): there is nothing to submit. Run the completion script and stop:
   \`\`\`bash
   tsx /home/ubuntu/bottega/reference/scripts/complete-pr.ts ${taskId}
   \`\`\`
4. Push to origin: \`git push -u origin $(git branch --show-current)\`
5. Create PR with a short specific title and concise summary body. Replace the placeholders with the actual task title and implementation summary:
   \`gh pr create --title "<short task title>" --body "Summary: <what the task does and how this implementation solves it. Keep this to a short paragraph. Task: #${taskId}>"\``;
}

export async function generatePlanificationMessage(
  taskDocPath: string,
  taskId: number,
  isTechnical: boolean = true,
): Promise<string> {
  const promptName = isTechnical ? 'planification' : 'planification-nontechnical';
  const planTemplatePath = resolvePromptPath('plan-template');
  return renderPrompt(promptName, { taskDocPath, taskId, planTemplatePath });
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
): Promise<string> {
  return renderPrompt('refinement', { taskDocPath, taskId });
}

export async function generatePrAgentMessage(
  taskDocPath: string,
  taskId: number,
  prUrl: string | null | undefined,
): Promise<string> {
  const prContextLine = prUrl
    ? `- Existing PR: ${prUrl}`
    : '- No PR exists yet - you need to create one';
  const prCreateOrVerifyBlock = buildPrCreateOrVerifyBlock(taskId, prUrl);
  return renderPrompt('pr', { taskDocPath, taskId, prContextLine, prCreateOrVerifyBlock });
}

export async function generateYoloMessage(
  taskDocPath: string,
  taskId: number,
  prUrl: string | null | undefined,
): Promise<string> {
  const prContextLine = prUrl
    ? `- Existing PR: ${prUrl}`
    : '- No PR exists yet - you will create one at the end';
  const prCreateOrVerifyBlock = buildPrCreateOrVerifyBlock(taskId, prUrl);
  return renderPrompt('yolo', { taskDocPath, taskId, prContextLine, prCreateOrVerifyBlock });
}

export async function generatePrAgentCommentMessage(
  taskDocPath: string,
  taskId: number,
  prUrl: string | null | undefined,
  webhookContext: CommentWebhookContext,
): Promise<string> {
  const { commentBody, commentAuthor, fileContext } = webhookContext || {};

  const quotedComment = commentBody
    ? commentBody
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    : '> (empty comment)';

  let fileLocationSection = '';
  if (fileContext?.path) {
    const lineInfo =
      fileContext.startLine && fileContext.line && fileContext.startLine !== fileContext.line
        ? `lines ${fileContext.startLine}-${fileContext.line}`
        : fileContext.line
          ? `line ${fileContext.line}`
          : '';

    fileLocationSection = `
### Comment Location
- **File**: \`${fileContext.path}\`${lineInfo ? `\n- **Line**: ${lineInfo}` : ''}${fileContext.side ? `\n- **Side**: ${fileContext.side === 'LEFT' ? 'Original code (before changes)' : 'New code (after changes)'}` : ''}
`;

    if (fileContext.diffHunk) {
      fileLocationSection += `
### Code Context (from diff)
\`\`\`diff
${fileContext.diffHunk}
\`\`\`
`;
    }
  }

  const feedbackSection = `## User Feedback
**@${commentAuthor || 'unknown'}** left the following comment on the PR:

${quotedComment}
${fileLocationSection}`;

  return renderPrompt('pr-feedback', { taskDocPath, taskId, prUrl, feedbackSection });
}

export async function generatePrAgentReviewMessage(
  taskDocPath: string,
  taskId: number,
  prUrl: string | null | undefined,
  webhookContext: ReviewWebhookContext,
): Promise<string> {
  const { reviewBody, reviewAuthor, comments } = webhookContext || {};

  let reviewBodySection = '';
  if (reviewBody) {
    const quotedReview = reviewBody
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    reviewBodySection = `
### Review Summary
**@${reviewAuthor || 'unknown'}** wrote:

${quotedReview}
`;
  }

  let inlineCommentsSection = '';
  if (comments && comments.length > 0) {
    const commentEntries = comments
      .map((c, i) => {
        const { commentBody, commentAuthor, fileContext } = c;
        let entry = `#### ${i + 1}. `;

        if (fileContext?.path) {
          const lineInfo =
            fileContext.startLine &&
            fileContext.line &&
            fileContext.startLine !== fileContext.line
              ? `lines ${fileContext.startLine}-${fileContext.line}`
              : fileContext.line
                ? `line ${fileContext.line}`
                : '';
          entry += `\`${fileContext.path}\`${lineInfo ? ` (${lineInfo})` : ''}`;
        } else {
          entry += 'General comment';
        }

        entry += `\n**@${commentAuthor || 'unknown'}**:`;
        entry += `\n${commentBody || '(empty comment)'}`;

        if (fileContext?.diffHunk) {
          entry += `\n\n<details><summary>Code context (from diff)</summary>\n\n\`\`\`diff\n${fileContext.diffHunk}\n\`\`\`\n</details>`;
        }

        return entry;
      })
      .join('\n\n');

    inlineCommentsSection = `
### Inline Comments (${comments.length})
${commentEntries}
`;
  }

  const feedbackSection = `## User Feedback${reviewBodySection}${inlineCommentsSection}`;

  return renderPrompt('pr-feedback', { taskDocPath, taskId, prUrl, feedbackSection });
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
