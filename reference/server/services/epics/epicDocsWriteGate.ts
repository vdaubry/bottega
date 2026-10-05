// Containment for the epic agents that write files.
//
// Epic document stages now use provider-neutral archive tools and deny native
// writers. This Claude PreToolUse gate remains defense in depth for historical
// or manually resumed sessions whose native write surface was already built:
// any such call is confined to the stage-owned archive directories.
//
// A manual epic chat (no linked run) gets no gate — and no write tools either,
// since `disallowedTools` is derived from the same rows.
//
// WHY A PreToolUse HOOK (not `canUseTool`): under `permissionMode:
// 'bypassPermissions'` — the mode every Bottega turn uses — the SDK
// auto-approves tool calls without consulting `canUseTool`. PreToolUse hooks do
// fire for every call in that mode. Same reasoning, same mechanism as
// `backgroundTaskGate.ts`; see its header for the verified SDK details.
//
// Like the MCP injection, the gate is derived from the conversation's DB rows,
// so a follow-up revision message (`sendMessage`) and the 401-retry path are
// contained exactly like the run's first turn.

import path from 'path';
import { conversationsDb } from '../../database/conversations.js';
import { epicsDb, epicAgentRunsDb } from '../../database/epics.js';
import { getEpicStageWritableDirs } from './epicArchive.js';
import { EPIC_DISALLOWED_TOOLS_BY_STAGE } from './epicAgents.js';

/** Tools that create or modify files on disk. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

interface PreToolUseHookInputLike {
  tool_name?: string;
  tool_input?: unknown;
  cwd?: string;
}

interface PreToolUseHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    permissionDecision?: 'allow' | 'deny';
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
}

export type PreToolUseHook = (input: PreToolUseHookInputLike) => Promise<PreToolUseHookOutput>;

/** Lexical containment: `child` is `parent` itself or below it. */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Build the gate for a stage's archive directories. Relative paths are resolved
 * against the session cwd (the SDK's own rule) — which is the repo, so they are
 * denied with a message naming the absolute directories to use instead.
 *
 * Containment is lexical: a symlink planted inside the directory could still
 * point out of it. That is not the threat model here (the agent writes the symlink
 * only if it already has the write it is being denied), and the same residual
 * risk as `settingSources` loading the target repo's own `.claude` config.
 */
export function buildEpicDocsWriteGate(writableDirs: string[]): PreToolUseHook {
  const roots = writableDirs.map((dir) => path.resolve(dir));
  const rootList = roots.join(', ');

  return (input: PreToolUseHookInputLike): Promise<PreToolUseHookOutput> => {
    const toolName = input?.tool_name;
    if (!toolName || !WRITE_TOOLS.has(toolName)) return Promise.resolve({});

    // Write/Edit/MultiEdit address the file as `file_path`; NotebookEdit as `notebook_path`.
    const toolInput = input.tool_input as
      | { file_path?: unknown; notebook_path?: unknown }
      | undefined;
    const filePath = toolInput?.file_path ?? toolInput?.notebook_path;
    const deny = (reason: string): Promise<PreToolUseHookOutput> =>
      Promise.resolve({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      });

    if (typeof filePath !== 'string' || filePath.trim() === '') {
      return deny(
        `${toolName} needs an absolute path inside this stage's archive director${roots.length === 1 ? 'y' : 'ies'} (${rootList}).`,
      );
    }

    const resolved = path.resolve(input.cwd ?? process.cwd(), filePath);
    if (!roots.some((root) => isInside(root, resolved))) {
      return deny(
        `Writing to ${resolved} is not allowed. This epic agent may only write inside its ` +
          `stage's archive director${roots.length === 1 ? 'y' : 'ies'}: ${rootList}. Use an absolute path ` +
          'under one of those (never write into the repository).',
      );
    }

    // Inside the directory — a bare {} leaves the ambient bypassPermissions
    // approval in place rather than overriding another hook's decision.
    return Promise.resolve({});
  };
}

/**
 * The gate a conversation should run with, derived from its rows: epic
 * conversation + a linked run whose stage writes documents. Returns null for
 * every other conversation (tasks, manual epic chats, stages that write
 * nothing), which then get no extra hook at all.
 */
export function epicDocsWriteGateForConversation(conversationId: number): PreToolUseHook | null {
  const conversation = conversationsDb.getById(conversationId);
  const epicId = conversation?.epic_id;
  if (epicId == null) return null;

  const agentType = epicAgentRunsDb.getByConversationId(conversationId)?.agent_type;
  if (!agentType || !(agentType in EPIC_DISALLOWED_TOOLS_BY_STAGE)) return null;

  const epic = epicsDb.getById(epicId);
  if (!epic) return null;

  const dirs = getEpicStageWritableDirs(agentType, epic.project_id, epicId);
  return dirs.length > 0 ? buildEpicDocsWriteGate(dirs) : null;
}

/**
 * The disallowed-tools catalog a conversation's SDK session must carry, derived
 * from its rows exactly like the write gate above: an epic conversation whose
 * linked run is an epic agent gets that stage's catalog
 * (`EPIC_DISALLOWED_TOOLS_BY_STAGE`); every other conversation — tasks, manual
 * epic chats without a run — gets undefined.
 *
 * `startEpicAgentRun` applies the same catalog on the run's first turn. This
 * helper exists for the RESUME path (`sendMessage`): without it, every later
 * turn — an orchestrator wake, a specification revision — would run with the
 * denied tools silently restored (found live in the Phase-7 QA run: the
 * orchestrator executed Bash on a wake turn).
 */
export function epicDisallowedToolsForConversation(conversationId: number): string[] | undefined {
  const conversation = conversationsDb.getById(conversationId);
  if (conversation?.epic_id == null) return undefined;

  const agentType = epicAgentRunsDb.getByConversationId(conversationId)?.agent_type;
  if (!agentType || !(agentType in EPIC_DISALLOWED_TOOLS_BY_STAGE)) return undefined;

  return EPIC_DISALLOWED_TOOLS_BY_STAGE[agentType];
}

export const _internal = { WRITE_TOOLS, isInside };
