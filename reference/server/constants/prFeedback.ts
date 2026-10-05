/**
 * Rendering a GitHub PR comment or review as a prompt section.
 *
 * The same bytes reach two different agents: a ticket's `pr` agent, when the
 * comment lands on `task/{id}-…` (`pr-feedback.md`), and the epic's
 * `epic-delivery` agent, when it lands on the epic's final pull request
 * (`epic-delivery.md`). The webhook route parses the payload once and both
 * paths quote it the same way, so feedback reads identically wherever it
 * arrives.
 *
 * Domain-neutral by design — `server/constants/**` is imported by the task
 * prompts and the epic layer alike, and neither owns this shape.
 */

// `?: T | undefined` throughout, not `?: T`: under `exactOptionalPropertyTypes`
// a caller holding `{ commentBody: string | undefined }` — which is what the
// webhook payload parsers produce — is only assignable to the explicit form.
export interface FileContext {
  path?: string | undefined;
  line?: number | null | undefined;
  startLine?: number | null | undefined;
  diffHunk?: string | null | undefined;
  side?: string | null | undefined;
}

export interface CommentWebhookContext {
  commentBody?: string | undefined;
  commentAuthor?: string | undefined;
  fileContext?: FileContext | null | undefined;
}

export interface ReviewComment {
  commentBody?: string | undefined;
  commentAuthor?: string | undefined;
  fileContext?: FileContext | null | undefined;
}

export interface ReviewWebhookContext {
  reviewBody?: string | null | undefined;
  reviewAuthor?: string | undefined;
  comments?: ReviewComment[] | undefined;
}

/** "lines 12-18", "line 12", or "" when GitHub gave no position. */
function lineInfoOf(fileContext: FileContext): string {
  if (fileContext.startLine && fileContext.line && fileContext.startLine !== fileContext.line) {
    return `lines ${fileContext.startLine}-${fileContext.line}`;
  }
  return fileContext.line ? `line ${fileContext.line}` : '';
}

function quoteBlock(body: string): string {
  return body
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/** One PR comment, quoted, with its file/line anchor and diff hunk if any. */
export function buildCommentFeedbackSection(webhookContext: CommentWebhookContext): string {
  const { commentBody, commentAuthor, fileContext } = webhookContext || {};

  const quotedComment = commentBody ? quoteBlock(commentBody) : '> (empty comment)';

  let fileLocationSection = '';
  if (fileContext?.path) {
    const lineInfo = lineInfoOf(fileContext);

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

  return `## User Feedback
**@${commentAuthor || 'unknown'}** left the following comment on the PR:

${quotedComment}
${fileLocationSection}`;
}

/** A submitted review: its body, then every inline comment in order. */
export function buildReviewFeedbackSection(webhookContext: ReviewWebhookContext): string {
  const { reviewBody, reviewAuthor, comments } = webhookContext || {};

  let reviewBodySection = '';
  if (reviewBody) {
    reviewBodySection = `
### Review Summary
**@${reviewAuthor || 'unknown'}** wrote:

${quoteBlock(reviewBody)}
`;
  }

  let inlineCommentsSection = '';
  if (comments && comments.length > 0) {
    const commentEntries = comments
      .map((c, i) => {
        const { commentBody, commentAuthor, fileContext } = c;
        let entry = `#### ${i + 1}. `;

        if (fileContext?.path) {
          const lineInfo = lineInfoOf(fileContext);
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

  return `## User Feedback${reviewBodySection}${inlineCommentsSection}`;
}
