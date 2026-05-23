// Map generic `ProviderRunOptions` onto Codex SDK's `ThreadOptions`.
//
// Reference shape from `node_modules/@openai/codex-sdk/dist/index.d.ts`
// (captured in docs/codex-sdk-integration.md). The Codex SDK uses
// `modelReasoningEffort` for the effort knob (top-level on
// `ThreadOptions`, not nested under `config` — confirmed by the
// Phase 8 spike).

import type {
  ApprovalMode,
  ModelReasoningEffort,
  SandboxMode,
  ThreadOptions,
} from '@openai/codex-sdk';
import type { ProviderRunOptions } from '@shared/providers/types';
import { OPENAI_EFFORTS } from '@shared/providers/models';

const PERMISSION_TO_SANDBOX: Record<string, { sandboxMode: SandboxMode; approvalPolicy: ApprovalMode }> = {
  default: { sandboxMode: 'workspace-write', approvalPolicy: 'untrusted' },
  acceptEdits: { sandboxMode: 'workspace-write', approvalPolicy: 'never' },
  bypassPermissions: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
  plan: { sandboxMode: 'read-only', approvalPolicy: 'on-request' },
};

/**
 * Map Bottega's PermissionMode onto Codex's sandbox + approval-policy
 * pair. Ported verbatim from `claudecodeui`'s
 * `mapPermissionModeToCodexOptions` (server/openai-codex.js:168-187).
 * Bottega's runtime default is `bypassPermissions` (D8), so most
 * concrete Codex turns will pass `danger-full-access` + `never`. The
 * `plan` mode is mapped to read-only with on-request approval to
 * preserve the spirit of Anthropic's plan mode (never modifies disk).
 */
export function mapPermissionModeToCodexOptions(
  mode: string | undefined,
): { sandboxMode: SandboxMode; approvalPolicy: ApprovalMode } {
  return PERMISSION_TO_SANDBOX[mode ?? 'default'] ?? PERMISSION_TO_SANDBOX.default!;
}

function normalizeEffort(effort: string | null | undefined): ModelReasoningEffort | undefined {
  if (!effort) return undefined;
  return (OPENAI_EFFORTS as readonly string[]).includes(effort)
    ? (effort as ModelReasoningEffort)
    : undefined;
}

/**
 * Convert generic `ProviderRunOptions` into Codex SDK `ThreadOptions`.
 * `skipGitRepoCheck: true` is hardcoded — matches the reference impl
 * and Bottega worktree paths aren't always git repos in the
 * conventional sense.
 */
export function buildCodexThreadOptions(options: ProviderRunOptions): ThreadOptions {
  const sandboxAndApproval = mapPermissionModeToCodexOptions(options.permissionMode);

  const out: ThreadOptions = {
    workingDirectory: options.cwd,
    skipGitRepoCheck: true,
    sandboxMode: sandboxAndApproval.sandboxMode,
    approvalPolicy: sandboxAndApproval.approvalPolicy,
    // Always explicit — `model` is required and validated upstream (the
    // create-conversation schema and the agent-settings validator both gate
    // it against OPENAI_MODELS), so a Codex turn never runs on the SDK default.
    model: options.model,
  };

  const effort = normalizeEffort(options.effort);
  if (effort) out.modelReasoningEffort = effort;

  return out;
}
