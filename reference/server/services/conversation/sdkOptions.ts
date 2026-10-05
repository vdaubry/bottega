import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { sqliteSessionStore } from '../sqliteSessionStore.js';
import { backgroundTaskPreToolUseHook } from './backgroundTaskGate.js';
import { FIGMA_WRITE_TOOLS } from '../../constants/figmaTools.js';
import type { SdkLocalPlugin } from './pluginConfig.js';
import type { PermissionMode } from '@shared/websocket/messages';

// bypassPermissions allows Claude to write files without prompting.
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'bypassPermissions';

// The Claude Agent SDK enforces a hard `min(1).max(4)` on AskUserQuestion.questions
// (see node_modules/@anthropic-ai/claude-agent-sdk/cli.js). Calls with >4 questions
// fail validation before our `canUseTool` runs, leaving a broken widget. The model
// already gets similar guidance from the preset, but reinforcing it noticeably
// reduces overshoot.
const ASK_USER_QUESTION_LIMIT_NOTE =
  '\n\nWhen using the AskUserQuestion tool, ask at most 4 questions per call. ' +
  'If you have more questions, split them across multiple sequential AskUserQuestion calls.';

export interface ValidateOptionsInput {
  broadcastFn?: unknown;
  permissionMode?: PermissionMode | undefined;
}

/**
 * Validates and normalizes options for conversation functions.
 * Logs warnings for missing options and applies safe defaults.
 */
export function validateAndNormalizeOptions<T extends ValidateOptionsInput>(
  options: T = {} as T,
  source: string,
): T & { permissionMode: PermissionMode } {
  const warnings: string[] = [];

  if (!options.broadcastFn) {
    warnings.push('Missing broadcastFn - WebSocket broadcasts will not work');
  }

  if (!options.permissionMode) {
    warnings.push(`Missing permissionMode, defaulting to '${DEFAULT_PERMISSION_MODE}'`);
  }

  if (warnings.length > 0) {
    console.warn(`[ConversationAdapter] Options validation (${source}):`, warnings.join('; '));
  }

  return {
    ...options,
    permissionMode: options.permissionMode || DEFAULT_PERMISSION_MODE,
  };
}

export interface MapOptionsInput {
  sessionId?: string | undefined;
  cwd?: string | undefined;
  permissionMode?: PermissionMode | undefined;
  customSystemPrompt?: string | undefined;
  canUseTool?: unknown;
  env?: Record<string, string | undefined> | undefined;
  /** Required — Claude turns always run on an explicit model (never the SDK default). */
  model: string;
  /** Reasoning effort, or null when none was chosen. */
  effort?: string | null | undefined;
  disallowedTools?: string[] | undefined;
  /**
   * Extra PreToolUse hooks appended after the always-on background-task gate
   * (epic doc-write containment today). Hooks run in order and the first `deny`
   * wins, so an added hook can only narrow the tool surface, never widen it.
   */
  extraPreToolUseHooks?: Array<(input: never) => unknown> | undefined;
}

export interface SDKOptions {
  env?: Record<string, string | undefined>;
  canUseTool?: unknown;
  cwd?: string;
  permissionMode?: PermissionMode;
  model?: string;
  effort?: string;
  systemPrompt?: string | { type: 'preset'; preset: string; append?: string };
  settingSources?: string[];
  includePartialMessages?: boolean;
  thinking?: { type: string; display: string };
  disallowedTools?: string[];
  resume?: string;
  sessionStore?: typeof sqliteSessionStore;
  sessionStoreFlush?: 'eager' | 'lazy';
  mcpServers?: Record<string, unknown>;
  /** Operator plugins named explicitly — see `conversation/pluginConfig.ts`. */
  plugins?: SdkLocalPlugin[];
  hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => unknown> }>>;
}

/**
 * Maps options to SDK-compatible format
 */
export function mapOptionsToSDK(options: MapOptionsInput): SDKOptions {
  const { sessionId, cwd, permissionMode, customSystemPrompt, canUseTool, env } = options;

  const sdkOptions: SDKOptions = {};

  if (env) {
    sdkOptions.env = env;
  }

  if (canUseTool) {
    sdkOptions.canUseTool = canUseTool;
  }

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  // Always explicit — `model` is required on the input.
  sdkOptions.model = options.model;

  if (options.effort) {
    sdkOptions.effort = options.effort;
  }

  if (customSystemPrompt) {
    // Custom agents use full override - plain string replaces the entire system prompt
    sdkOptions.systemPrompt = customSystemPrompt + ASK_USER_QUESTION_LIMIT_NOTE;
  } else {
    sdkOptions.systemPrompt = {
      type: 'preset',
      preset: 'claude_code',
      append: ASK_USER_QUESTION_LIMIT_NOTE,
    };
  }

  sdkOptions.settingSources = ['project', 'user', 'local'];

  // Required to capture plaintext thinking deltas. Since SDK 0.2.x, the final
  // assistant message has empty `thinking` (only the encrypted signature is
  // preserved); the plaintext text is delivered solely via stream_event partials.
  sdkOptions.includePartialMessages = true;

  // Without `display: 'summarized'` the SDK defaults to omitting thinking text
  // entirely (only the signature comes through), which is what made the
  // thinking widget render empty after the SDK upgrade.
  sdkOptions.thinking = { type: 'adaptive', display: 'summarized' };

  // Figma writes are denied for every agent, on every turn — see
  // constants/figmaTools.ts. Set unconditionally (not gated on the caller
  // passing a list): most callers pass `[]`, and an empty list must still
  // carry the Figma denial.
  sdkOptions.disallowedTools = [...(options.disallowedTools ?? []), ...FIGMA_WRITE_TOOLS];

  if (sessionId) {
    sdkOptions.resume = sessionId;
  }

  // Custom transcript backend. The SDK calls SqliteSessionStore.append/load/...
  // for every conversation; our app reads transcripts exclusively from SQLite.
  // The SDK still writes its own JSONL copies under CLAUDE_CONFIG_DIR, but
  // those files are private to the SDK and never read by this codebase.
  sdkOptions.sessionStore = sqliteSessionStore;

  // Without this, the SDK's transcript-mirror batcher buffers up to 500 entries
  // / 1 MiB before draining to our store (no time-based flush), so mid-turn
  // reloads of /api/conversations/:id/messages return an empty history —
  // the WS stream stays in sync, but SQLite is stale until the turn closes.
  sdkOptions.sessionStoreFlush = 'eager';

  // Defense-in-depth: force `Bash run_in_background` to the foreground and deny
  // the defer-past-this-turn tools (`Monitor`, `ScheduleWakeup`, `CronCreate`),
  // so a backgrounded/monitored/scheduled task can never be orphaned by the
  // per-turn subprocess teardown even if the SDK's internal
  // CLAUDE_CODE_DISABLE_BACKGROUND_TASKS env flag is renamed. A PreToolUse hook
  // is used (not canUseTool) because canUseTool is NOT consulted under
  // permissionMode 'bypassPermissions' — the mode every turn uses — whereas
  // PreToolUse hooks fire for every tool call. See backgroundTaskGate.ts.
  //
  // Callers append their own gates through `extraPreToolUseHooks` (the epic
  // docs-write containment). They run after this one, in order.
  sdkOptions.hooks = {
    PreToolUse: [
      {
        hooks: [
          backgroundTaskPreToolUseHook as (input: unknown) => unknown,
          ...((options.extraPreToolUseHooks ?? []) as Array<(input: unknown) => unknown>),
        ],
      },
    ],
  };

  return sdkOptions;
}

/**
 * Loads MCP server configurations from ~/.claude.json
 */
export async function loadMcpConfig(
  cwd: string | null | undefined,
): Promise<Record<string, unknown> | null> {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    try {
      await fs.access(claudeConfigPath);
    } catch {
      return null;
    }

    const configContent = await fs.readFile(claudeConfigPath, 'utf8');
    const claudeConfig = JSON.parse(configContent) as {
      mcpServers?: Record<string, unknown>;
      claudeProjects?: Record<string, { mcpServers?: Record<string, unknown> }>;
    };

    let mcpServers: Record<string, unknown> = {};

    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
    }

    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig?.mcpServers) {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
      }
    }

    return Object.keys(mcpServers).length > 0 ? mcpServers : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ConversationAdapter] Error loading MCP config:', message);
    return null;
  }
}
