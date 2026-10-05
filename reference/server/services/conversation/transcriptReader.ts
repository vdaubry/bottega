// The transcript reader — how a supervising agent inspects another agent's turn.
//
// Everything an agent did is already in the `messages` table: its text, its
// reasoning, every tool call with its arguments and every result that came
// back. The UI reads it through `/api/conversations/:id/messages`. This module
// is the same read, rendered for a model instead of a React tree, and windowed
// so a run of a thousand entries can be inspected without loading it whole.
//
// It is infrastructure: it resolves a conversation id to its transcript and
// says nothing about who may read it. Authorization — "this run belongs to a
// ticket of my epic" — is the caller's job, and the only caller today is the
// epic orchestrator's `read_agent_transcript` tool.
//
// Provider-neutral by construction: the Codex and OpenCode mirrors
// (`providers/*/messageMirror.ts`) write the same on-the-wire entry shape the
// Claude session store does, so one normalizer covers all three.

import { conversationsDb } from '../../database/conversations.js';
import {
  conversationContentStore,
  type TranscriptEntry,
} from '../conversationContentStore.js';

/** Entries that exist for the UI's benefit and say nothing about the work. */
const BOOKKEEPING_TYPES = new Set([
  'queue-operation',
  'last-prompt',
  'ai-title',
  'mode',
  'attachment',
  'progress',
  'summary',
  'file-history-snapshot',
]);

/** How much of one block is rendered before it is cut. */
export const DEFAULT_BLOCK_CHARS = 800;
/** Entries per window when the caller does not say. */
export const DEFAULT_WINDOW = 40;
/** Hard ceiling on one rendered slice, expanded blocks included. */
export const MAX_RENDER_CHARS = 100_000;

export type BlockKind = 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'meta';

export interface NormalizedBlock {
  kind: BlockKind;
  /** Tool name — on a `tool_use`, and on the `tool_result` that answers it. */
  tool?: string;
  toolUseId?: string;
  isError?: boolean;
  /** Rendered body: JSON arguments for a call, flattened text otherwise. */
  body: string;
}

export interface NormalizedEntry {
  /** Position in the filtered stream. Stable — what `before`/`expand` address. */
  index: number;
  role: 'user' | 'assistant' | 'system';
  timestamp: string | null;
  blocks: NormalizedBlock[];
}

export interface ToolUsage {
  tool: string;
  calls: number;
  errors: number;
}

export interface TranscriptMeta {
  conversationId: number;
  name: string | null;
  provider: string;
  model: string | null;
  sessionId: string;
  cwd: string;
  subagent: string | null;
  /** Entries kept after bookkeeping was dropped. */
  totalEntries: number;
  hiddenEntries: number;
  toolUsage: ToolUsage[];
  subagents: string[];
  /** Entries carrying a provider/API error — the first thing to look at. */
  errorIndices: number[];
}

export interface TranscriptWindow {
  meta: TranscriptMeta;
  /** The slice actually rendered, in stream order. */
  entries: NormalizedEntry[];
  /** Inclusive bounds of `entries` in the full stream, or null when empty. */
  from: number | null;
  to: number | null;
  /** Indices that matched `search`, when one was given. */
  matches: number[] | null;
}

export interface ReadTranscriptOptions {
  /** Entries to return. Default `DEFAULT_WINDOW`. */
  limit?: number | undefined;
  /** Return the window ENDING here (exclusive). Default: the end of the run. */
  before?: number | null | undefined;
  /** Keep only entries containing this text (case-insensitive). */
  search?: string | null | undefined;
  /** Subagent transcript to read instead of the main one. */
  subagent?: string | null | undefined;
}

export interface RenderOptions {
  /** Render these blocks untruncated: a `tool_use` id, or `#<entryIndex>`. */
  expand?: string | null | undefined;
  maxBlockChars?: number | undefined;
}

export class TranscriptUnavailableError extends Error {}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        const block = part as { type?: string; text?: string };
        if (block?.type === 'text') return block.text ?? '';
        if (block?.type === 'image') return '[image]';
        return typeof part === 'string' ? part : JSON.stringify(part);
      })
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(value);
}

function timestampOf(entry: TranscriptEntry): string | null {
  const raw = entry.timestamp;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return new Date(raw).toISOString();
  return null;
}

/**
 * Content blocks of one entry, flattened. Kept deliberately lossless for the
 * four kinds that carry work — text, reasoning, calls, results — because the
 * caller is debugging, not skimming.
 */
function blocksOf(entry: TranscriptEntry): NormalizedBlock[] {
  const type = entry.type;

  if (type === 'system') {
    const subtype = (entry as { subtype?: string }).subtype ?? 'system';
    const body = textOf((entry as { content?: unknown }).content) || subtype;
    return [{ kind: 'meta', body: `system/${subtype}${body === subtype ? '' : `: ${body}`}` }];
  }

  if (type === 'result') {
    const isError = (entry as { is_error?: boolean }).is_error === true;
    const errors = (entry as { errors?: unknown }).errors;
    const detail = errors ? `: ${textOf(errors)}` : '';
    return [
      {
        kind: 'meta',
        isError,
        body: `turn ended ${isError ? 'WITH ERROR' : 'ok'}${detail}`,
      },
    ];
  }

  if (type === 'agent_metadata') {
    const meta = entry as { agentType?: string; description?: string };
    return [
      {
        kind: 'meta',
        body: `subagent ${meta.agentType ?? '?'} — ${meta.description ?? ''}`.trim(),
      },
    ];
  }

  if (type === 'pr-link') {
    const link = entry as { prUrl?: string; prNumber?: number };
    return [{ kind: 'meta', body: `pull request #${link.prNumber ?? '?'} ${link.prUrl ?? ''}`.trim() }];
  }

  const content = entry.message?.content;
  if (typeof content === 'string') {
    return content.trim() ? [{ kind: 'text', body: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const blocks: NormalizedBlock[] = [];
  for (const raw of content) {
    const block = raw as {
      type?: string;
      text?: string;
      thinking?: string;
      name?: string;
      id?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    };
    switch (block.type) {
      case 'text':
        if (block.text?.trim()) blocks.push({ kind: 'text', body: block.text });
        break;
      case 'thinking':
        if (block.thinking?.trim()) blocks.push({ kind: 'thinking', body: block.thinking });
        break;
      case 'tool_use':
        blocks.push({
          kind: 'tool_use',
          tool: block.name ?? 'unknown',
          ...(block.id ? { toolUseId: block.id } : {}),
          body: JSON.stringify(block.input ?? {}, null, 2),
        });
        break;
      case 'tool_result':
        blocks.push({
          kind: 'tool_result',
          ...(block.tool_use_id ? { toolUseId: block.tool_use_id } : {}),
          ...(block.is_error ? { isError: true } : {}),
          body: textOf(block.content),
        });
        break;
      case undefined:
      default:
        // Anything the providers add later: skipped, never crashed on.
        break;
    }
  }
  return blocks;
}

/**
 * Drop the UI bookkeeping, flatten the rest, and name every result after the
 * call it answers — a `tool_result` alone says nothing about what ran.
 */
export function normalizeEntries(entries: TranscriptEntry[]): {
  normalized: NormalizedEntry[];
  hidden: number;
} {
  const toolNames = new Map<string, string>();
  const normalized: NormalizedEntry[] = [];
  let hidden = 0;

  for (const entry of entries) {
    if (BOOKKEEPING_TYPES.has(entry.type ?? '')) {
      hidden += 1;
      continue;
    }
    const blocks = blocksOf(entry);
    if (blocks.length === 0) {
      hidden += 1;
      continue;
    }
    for (const block of blocks) {
      if (block.kind === 'tool_use' && block.toolUseId && block.tool) {
        toolNames.set(block.toolUseId, block.tool);
      }
      if (block.kind === 'tool_result' && block.toolUseId) {
        const name = toolNames.get(block.toolUseId);
        if (name) block.tool = name;
      }
    }
    if (entry.isApiErrorMessage) {
      for (const block of blocks) block.isError = true;
    }
    normalized.push({
      index: normalized.length,
      role: entry.type === 'assistant' ? 'assistant' : entry.type === 'user' ? 'user' : 'system',
      timestamp: timestampOf(entry),
      blocks,
    });
  }

  return { normalized, hidden };
}

/** Which tools ran, how often, and how many answers came back as errors. */
export function summarizeToolUsage(entries: NormalizedEntry[]): ToolUsage[] {
  const tally = new Map<string, ToolUsage>();
  for (const entry of entries) {
    for (const block of entry.blocks) {
      const name = block.tool;
      if (!name) continue;
      const row = tally.get(name) ?? { tool: name, calls: 0, errors: 0 };
      if (block.kind === 'tool_use') row.calls += 1;
      if (block.kind === 'tool_result' && block.isError) row.errors += 1;
      tally.set(name, row);
    }
  }
  return [...tally.values()].sort((a, b) => b.errors - a.errors || b.calls - a.calls);
}

function entryText(entry: NormalizedEntry): string {
  return entry.blocks.map((b) => `${b.tool ?? ''} ${b.body}`).join('\n');
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * One window of a conversation's transcript. Throws
 * `TranscriptUnavailableError` when there is nothing to read — a conversation
 * that never started, or whose session was purged.
 */
export async function readConversationTranscript(
  conversationId: number,
  options: ReadTranscriptOptions = {},
): Promise<TranscriptWindow> {
  const conversation = conversationsDb.getById(conversationId);
  if (!conversation) {
    throw new TranscriptUnavailableError(`Conversation ${conversationId} no longer exists.`);
  }
  const sessionId = conversation.claude_conversation_id;
  const cwd = conversation.session_path;
  if (!sessionId || !cwd) {
    throw new TranscriptUnavailableError(
      `Conversation ${conversationId} never started a session — there is no transcript. The run ` +
        'probably failed before its first turn; the agent run status says how it ended.',
    );
  }

  const subagent = options.subagent?.trim() || null;
  const [raw, subagents] = await Promise.all([
    conversationContentStore.loadEntries(sessionId, cwd, subagent),
    conversationContentStore.listSubagentTranscripts(sessionId, cwd),
  ]);
  if (!raw || raw.length === 0) {
    throw new TranscriptUnavailableError(
      subagent
        ? `No subagent transcript '${subagent}' on conversation ${conversationId}.`
        : `Conversation ${conversationId} has no stored messages.`,
    );
  }

  const { normalized, hidden } = normalizeEntries(raw);
  const meta: TranscriptMeta = {
    conversationId,
    name: conversation.name,
    provider: conversation.provider,
    model: conversation.model,
    sessionId,
    cwd,
    subagent,
    totalEntries: normalized.length,
    hiddenEntries: hidden,
    toolUsage: summarizeToolUsage(normalized),
    subagents,
    errorIndices: normalized
      .filter((e) => e.blocks.some((b) => b.isError))
      .map((e) => e.index),
  };

  const needle = options.search?.trim().toLowerCase() || null;
  const pool = needle
    ? normalized.filter((entry) => entryText(entry).toLowerCase().includes(needle))
    : normalized;
  const matches = needle ? pool.map((entry) => entry.index) : null;

  const limit = Math.max(1, options.limit ?? DEFAULT_WINDOW);
  // `before` addresses the full stream even when searching, so a caller can
  // page back from a match with the index the match reported.
  const upper = options.before ?? null;
  const visible = upper == null ? pool : pool.filter((entry) => entry.index < upper);
  const entries = visible.slice(Math.max(0, visible.length - limit));

  return {
    meta,
    entries,
    from: entries[0]?.index ?? null,
    to: entries[entries.length - 1]?.index ?? null,
    matches,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderBlock(
  entryIndex: number,
  block: NormalizedBlock,
  expand: string | null,
  maxChars: number,
): string {
  const expanded =
    expand != null &&
    (expand === block.toolUseId || expand === `#${entryIndex}` || expand === String(entryIndex));

  const header =
    block.kind === 'tool_use'
      ? `tool_use ${block.tool}${block.toolUseId ? ` (${block.toolUseId})` : ''}`
      : block.kind === 'tool_result'
        ? `tool_result ${block.tool ?? '?'}${block.toolUseId ? ` (${block.toolUseId})` : ''}` +
          (block.isError ? ' [ERROR]' : '')
        : block.kind;

  const body = block.body;
  const cut = !expanded && body.length > maxChars;
  const shown = cut ? body.slice(0, maxChars) : body;
  const tail = cut
    ? `\n    … ${body.length - maxChars} more chars — expand with expand="${
        block.toolUseId ?? `#${entryIndex}`
      }"`
    : '';

  const indented = shown
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
  return `  ${header}\n${indented}${tail}`;
}

/** The window as the model reads it: a header it can navigate from, then the entries. */
export function renderTranscript(window: TranscriptWindow, options: RenderOptions = {}): string {
  const { meta, entries } = window;
  const maxChars = options.maxBlockChars ?? DEFAULT_BLOCK_CHARS;
  const expand = options.expand?.trim() || null;

  const tools = meta.toolUsage.length
    ? meta.toolUsage
        .map((t) => `${t.tool}×${t.calls}${t.errors ? ` (${t.errors} errored)` : ''}`)
        .join(', ')
    : '(no tool was ever called)';

  const head = [
    `conversation ${meta.conversationId} — ${meta.name ?? 'unnamed'} · ${meta.provider}/${
      meta.model ?? '?'
    }`,
    `cwd ${meta.cwd}`,
    meta.subagent ? `subagent transcript ${meta.subagent}` : null,
    `${meta.totalEntries} entries (${meta.hiddenEntries} UI bookkeeping entries hidden)`,
    `tools: ${tools}`,
    meta.errorIndices.length
      ? `errors at entries: ${meta.errorIndices.slice(0, 30).join(', ')}${
          meta.errorIndices.length > 30 ? ', …' : ''
        }`
      : null,
    meta.subagents.length && !meta.subagent
      ? `subagent transcripts: ${meta.subagents.join(', ')}`
      : null,
    window.matches
      ? `search matched ${window.matches.length} entries: ${window.matches
          .slice(0, 40)
          .join(', ')}${window.matches.length > 40 ? ', …' : ''}`
      : null,
    entries.length === 0
      ? 'nothing in this window'
      : `showing entries ${window.from}–${window.to}` +
        (window.from != null && window.from > 0
          ? ` — page back with before=${window.from}`
          : ' — this is the start of the run'),
  ].filter(Boolean);

  const body = entries.map((entry) => {
    const stamp = entry.timestamp ? ` · ${entry.timestamp}` : '';
    const rendered = entry.blocks
      .map((block) => renderBlock(entry.index, block, expand, maxChars))
      .join('\n');
    return `[${entry.index}] ${entry.role}${stamp}\n${rendered}`;
  });

  const text = `${head.join('\n')}\n\n${body.join('\n\n')}`;
  return text.length > MAX_RENDER_CHARS
    ? `${text.slice(0, MAX_RENDER_CHARS)}\n\n… slice truncated at ${MAX_RENDER_CHARS} chars. Narrow it with a smaller limit or a search.`
    : text;
}
