// Defense-in-depth gate that neutralizes background execution at Bottega's own
// choke point, independent of the SDK's internal
// `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` env flag (undocumented and liable to
// rename across versions).
//
// Bottega runs one SDK subprocess per turn and aborts it at the terminal
// `result` (startConversation.ts onResult). A backgrounded shell
// (`Bash run_in_background`) or a `Monitor` until-loop is therefore killed at
// turn end and its cross-turn `<task-notification>` can never be delivered —
// the conversation deadlocks waiting for a completion that can't arrive.
//
// The same teardown strands the cross-turn *schedulers*, `ScheduleWakeup` and
// `CronCreate`. Their timers live in the CLI runtime's memory — nothing is
// written to disk — and `ScheduleWakeup` only means anything inside a `/loop`
// dynamic-mode run, which Bottega never starts. They are more damaging than
// `Monitor` because they report **success**: "Next wakeup scheduled for
// 14:26:00 … the harness re-invokes you when the wakeup fires". That is
// precisely what convinces the agent it is safe to stop working, so it ends the
// turn promising to check back, no wakeup ever arrives, and the conversation
// sits idle until a human sends another message. Observed repeatedly on PR
// agents waiting out CI.
//
// WHY A PreToolUse HOOK (not `canUseTool`): under `permissionMode:
// 'bypassPermissions'` — the mode every Bottega turn uses — the SDK
// auto-approves tool calls WITHOUT consulting `canUseTool` (verified against
// the 0.3.198 build: it emits a CLAUDE_SDK_CAN_USE_TOOL_SHADOWED warning and
// never invokes the callback for Bash/Monitor; the same warning string is still
// present in the 0.3.220 bundled CLI). PreToolUse hooks,
// by contrast, DO fire for every tool under bypassPermissions and can rewrite
// the tool input, so they are the SDK's own recommended mechanism for gating
// every call in this mode.

export const MONITOR_DENY_MESSAGE =
  'Background and Monitor tasks do not persist between turns in this environment — ' +
  'they are terminated when the turn ends and never deliver a completion notification. ' +
  'Run the command synchronously in the foreground with the Bash tool (no run_in_background; ' +
  'use a generous timeout, up to 600000 ms) so it completes within this turn.';

export const SCHEDULER_DENY_MESSAGE =
  'Scheduled wakeups do not persist between turns in this environment — this conversation ' +
  'runs one subprocess per turn, so the schedule is discarded when the turn ends and nothing ' +
  'will ever re-invoke you. If you end the turn here, the conversation stalls until a human ' +
  'sends another message. Wait inline instead, within this turn: poll in the foreground with ' +
  'the Bash tool using a bounded loop such as ' +
  '`for i in $(seq 1 18); do <check-command> && break; sleep 30; done`, with a generous ' +
  'timeout (up to 600000 ms). If the wait outlasts one Bash call, run the loop again in the ' +
  'next call. When you run out of attempts, report the status you actually observed and stop ' +
  '— never end a turn saying you will check back later.';

// Cross-turn schedulers whose timers cannot survive the per-turn subprocess.
// `CronDelete` / `CronList` are deliberately left alone: they only inspect or
// clean up existing jobs and cannot strand a turn.
const SCHEDULER_TOOLS = new Set(['ScheduleWakeup', 'CronCreate']);

interface PreToolUseHookInputLike {
  tool_name?: string;
  tool_input?: unknown;
}

interface PreToolUseHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    permissionDecision?: 'allow' | 'deny';
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
}

function deny(reason: string): Promise<PreToolUseHookOutput> {
  return Promise.resolve({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

/**
 * PreToolUse hook that forces `Bash run_in_background` to the foreground and
 * denies the tools that would defer work past the end of the turn (`Monitor`,
 * `ScheduleWakeup`, `CronCreate`). Returns an empty object (`{}`) for every
 * other tool / input so the SDK proceeds normally (a bare `{}` is a no-op that
 * does not override the ambient bypassPermissions auto-approval).
 *
 * The SDK's `HookCallback` contract expects a `Promise<HookJSONOutput>`, so we
 * return an already-resolved Promise (the decision itself is synchronous).
 */
export function backgroundTaskPreToolUseHook(
  input: PreToolUseHookInputLike,
): Promise<PreToolUseHookOutput> {
  const toolName = input?.tool_name;
  const toolInput = input?.tool_input;

  if (
    toolName === 'Bash' &&
    (toolInput as { run_in_background?: unknown } | undefined)?.run_in_background
  ) {
    return Promise.resolve({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: {
          ...(toolInput as Record<string, unknown>),
          run_in_background: false,
        },
      },
    });
  }

  if (toolName === 'Monitor') {
    return deny(MONITOR_DENY_MESSAGE);
  }

  if (toolName !== undefined && SCHEDULER_TOOLS.has(toolName)) {
    return deny(SCHEDULER_DENY_MESSAGE);
  }

  return Promise.resolve({});
}

export const _internal = { MONITOR_DENY_MESSAGE, SCHEDULER_DENY_MESSAGE, SCHEDULER_TOOLS };
