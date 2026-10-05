// In-process 'code-atlas' MCP server — gives Explore-initiated conversations
// the three tools ported from CodeAtlas (src/main/mcp.ts): open_file,
// highlight, render_artifact. Tools surface to the model as
// mcp__code-atlas__<name>. UI commands flow through the atlas bridge to the
// task's open Explore views and only report success once a view acked; with
// no view open, render_artifact still validates + persists (shown on next
// open) and the pointing tools politely no-op.

import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { tasksDb, taskArtifactsDb } from '../../database/db.js';
import { getWorkspaceForTask, WorkspaceError, type Workspace } from './workspace.js';
import {
  sendAtlasEvent,
  getAtlasSubscriberCount,
  ATLAS_ARTIFACT_ACK_TIMEOUT_MS,
} from './bridge.js';
import { ARTIFACT_KINDS, HIGHLIGHT_COLORS, type HighlightRange } from '@shared/types/atlas';

// A generated artifact is a complete standalone HTML document; reject anything
// that isn't and cap the size so a runaway generation can't bloat the DB / WS.
const ARTIFACT_HTML_MAX_BYTES = 512 * 1024;
const HTML_DOC_RE = /^\s*<!doctype html|^\s*<html/i;

// Structurally compatible with the MCP SDK's CallToolResult (which is not
// directly importable here — @modelcontextprotocol/sdk is the agent SDK's
// own dependency, not hoisted into ours).
interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function validateLine(line: number, lineCount: number, relPath: string): void {
  if (!Number.isInteger(line) || line < 1 || line > lineCount) {
    throw new WorkspaceError(
      `Invalid line ${line} for ${relPath}: file has ${lineCount} lines (valid range 1-${lineCount})`,
    );
  }
}

const NO_VIEW_NOTE =
  'No Explore view is open for this task right now — nothing was shown. ' +
  'The user can open it from the task page (Explore button).';

/**
 * Build the per-conversation server config. Each query() turn gets a fresh
 * instance closing over the taskId; the workspace is resolved lazily per tool
 * call so a worktree created or removed between turns is always reflected
 * (the equivalent of CodeAtlas's getWorkspace() indirection).
 */
export function buildAtlasMcpServer(args: { taskId: number; userId?: number | undefined }) {
  const { taskId, userId } = args;

  const requireWorkspace = async (): Promise<Workspace> => {
    const taskWithProject = tasksDb.getWithProject(taskId);
    if (!taskWithProject) {
      throw new WorkspaceError(`Task ${taskId} no longer exists`);
    }
    return getWorkspaceForTask(taskWithProject);
  };

  const openFileTool = tool(
    'open_file',
    'Open a file in the Explore view so the user can read it. ' +
      'Path is relative to the project root. ' +
      'If `line` is given, the view scrolls to make that line visible.',
    {
      path: z.string().describe('File path relative to the project root'),
      line: z.number().int().optional().describe('1-based line number to scroll into view'),
    },
    async ({ path: relPath, line }) => {
      try {
        const file = await (await requireWorkspace()).readFile(relPath);
        if (line !== undefined) validateLine(line, file.lineCount, file.path);
        if (getAtlasSubscriberCount(taskId) === 0) return ok(NO_VIEW_NOTE);
        await sendAtlasEvent(taskId, {
          type: 'atlas-open-file',
          path: file.path,
          content: file.content,
          ...(line !== undefined ? { line } : {}),
        });
        return ok(
          `Opened ${file.path} (${file.lineCount} lines)` +
            (line !== undefined ? `, scrolled to line ${line}` : ''),
        );
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  const highlightTool = tool(
    'highlight',
    'Paint highlight decorations on line ranges of a file in the Explore ' +
      'view (the file is opened first if needed). Use this to point the user ' +
      'at the exact lines that answer their question. Each call replaces ' +
      'previous highlights on that file.',
    {
      path: z.string().describe('File path relative to the project root'),
      ranges: z
        .array(
          z.object({
            start: z.number().int().describe('First line of the range (1-based)'),
            end: z
              .number()
              .int()
              .optional()
              .describe('Last line of the range, inclusive (defaults to start)'),
          }),
        )
        .min(1)
        .describe('Line ranges to highlight'),
      color: z.enum(HIGHLIGHT_COLORS).optional().describe('Highlight color (default yellow)'),
    },
    async ({ path: relPath, ranges, color }) => {
      try {
        const file = await (await requireWorkspace()).readFile(relPath);
        const normalized: HighlightRange[] = ranges.map((r) => {
          const end = r.end ?? r.start;
          validateLine(r.start, file.lineCount, file.path);
          validateLine(end, file.lineCount, file.path);
          if (end < r.start) {
            throw new WorkspaceError(`Invalid range ${r.start}-${end}: end is before start`);
          }
          return { start: r.start, end };
        });
        if (getAtlasSubscriberCount(taskId) === 0) return ok(NO_VIEW_NOTE);
        await sendAtlasEvent(taskId, {
          type: 'atlas-highlight',
          path: file.path,
          content: file.content,
          ranges: normalized,
          color: color ?? 'yellow',
        });
        const desc = normalized
          .map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`))
          .join(', ');
        return ok(`Highlighted lines ${desc} in ${file.path}`);
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  const renderArtifactTool = tool(
    'render_artifact',
    'Render a self-contained HTML artifact in the Explore view. `html` must be ' +
      'ONE complete standalone HTML document (`<!doctype html>…`) with all CSS ' +
      'and JS inlined and ZERO external resources — it is shown in a sandboxed ' +
      'iframe (scripts run, but no network, cookies, or app access). Each call ' +
      'replaces the previous artifact OF THE SAME `kind`; the three kinds ' +
      '(plan / flowchart / architecture) coexist. File references inside the ' +
      'artifact should be clickable and call ' +
      "parent.postMessage({ type: 'bottega-open-source', path, line }, '*') so " +
      'the host opens the file — this preserves the "view source" capability on ' +
      'top of the richer in-artifact detail. The artifact should also honor ' +
      "host theme messages ({ type: 'bottega-theme', theme }). After rendering, " +
      'summarize the artifact in chat.',
    {
      html: z.string().describe('A complete self-contained HTML document (no external resources)'),
      kind: z
        .enum(ARTIFACT_KINDS)
        .describe(
          'Which artifact this is: plan=the task plan as a beautiful HTML page, ' +
            'flowchart=a request/logic flow, architecture=a module/feature map. ' +
            'In auto mode, pick the best fit for this task and pass it here.',
        ),
      title: z.string().optional().describe('Short title shown on the kind switcher'),
    },
    async ({ html, kind, title }) => {
      try {
        // Validate shape + size before touching the UI or persistence, so a bad
        // generation never destroys the previous artifact of this kind.
        if (!HTML_DOC_RE.test(html)) {
          throw new WorkspaceError(
            'html must be a complete HTML document starting with <!doctype html> or <html>',
          );
        }
        const bytes = Buffer.byteLength(html, 'utf8');
        if (bytes > ARTIFACT_HTML_MAX_BYTES) {
          throw new WorkspaceError(
            `html is too large (${bytes} bytes; max ${ARTIFACT_HTML_MAX_BYTES}). ` +
              'Trim the artifact — keep it focused and self-contained.',
          );
        }

        const persist = (): void => taskArtifactsDb.upsert(taskId, { kind, title: title ?? null, html });

        if (getAtlasSubscriberCount(taskId) === 0) {
          persist();
          return ok(
            `${kind} artifact saved for this task (no Explore view is currently open). ` +
              'It will be shown when the user opens the Explore view.',
          );
        }

        // The view acks once the sandboxed iframe has mounted the document — a
        // failure rejects here and the last good artifact of this kind survives
        // (nothing persisted).
        await sendAtlasEvent(
          taskId,
          {
            type: 'atlas-render-artifact',
            kind,
            ...(title !== undefined ? { title } : {}),
            html,
          },
          ATLAS_ARTIFACT_ACK_TIMEOUT_MS,
        );
        persist();

        return ok(`Rendered ${kind} artifact "${title ?? kind}" in the Explore view.`);
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  console.log(`[atlas] code-atlas MCP server attached (task=${taskId}, user=${userId ?? '?'})`);

  return createSdkMcpServer({
    name: 'code-atlas',
    version: '0.1.0',
    tools: [openFileTool, highlightTool, renderArtifactTool],
  });
}
