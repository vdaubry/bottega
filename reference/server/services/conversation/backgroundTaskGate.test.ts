import { describe, it, expect } from 'vitest';
import {
  backgroundTaskPreToolUseHook,
  _internal,
} from './backgroundTaskGate.js';

describe('backgroundTaskPreToolUseHook', () => {
  it('forces Bash run_in_background to false while preserving other input fields', async () => {
    const out = await backgroundTaskPreToolUseHook({
      tool_name: 'Bash',
      tool_input: { command: 'bundle exec rspec', run_in_background: true, timeout: 600000 },
    });

    expect(out.hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        command: 'bundle exec rspec',
        run_in_background: false,
        timeout: 600000,
      },
    });
  });

  it('is a no-op for a plain foreground Bash call', async () => {
    const out = await backgroundTaskPreToolUseHook({
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
    });

    expect(out).toEqual({});
  });

  it('treats a falsy run_in_background as foreground (no-op)', async () => {
    const out = await backgroundTaskPreToolUseHook({
      tool_name: 'Bash',
      tool_input: { command: 'ls', run_in_background: false },
    });

    expect(out).toEqual({});
  });

  it('denies the Monitor tool with actionable foreground guidance', async () => {
    const out = await backgroundTaskPreToolUseHook({
      tool_name: 'Monitor',
      tool_input: { until: 'file exists' },
    });

    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toBe(_internal.MONITOR_DENY_MESSAGE);
    expect(_internal.MONITOR_DENY_MESSAGE).toMatch(/do not persist between turns/i);
    expect(_internal.MONITOR_DENY_MESSAGE).toMatch(/foreground/i);
    expect(out.hookSpecificOutput?.updatedInput).toBeUndefined();
  });

  it.each(['ScheduleWakeup', 'CronCreate'])(
    'denies %s, the cross-turn scheduler that silently strands the conversation',
    async (toolName) => {
      const out = await backgroundTaskPreToolUseHook({
        tool_name: toolName,
        tool_input: { delaySeconds: 150, reason: 'waiting for CI' },
      });

      expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(out.hookSpecificOutput?.permissionDecisionReason).toBe(
        _internal.SCHEDULER_DENY_MESSAGE,
      );
      expect(out.hookSpecificOutput?.updatedInput).toBeUndefined();
    },
  );

  it('tells the denied agent to poll inline rather than promise a later check', () => {
    // The failure this gate exists to prevent is behavioural, not mechanical:
    // the agent ends the turn saying "I'll check back shortly" and nothing ever
    // calls it back. The message has to supply the replacement behaviour.
    expect(_internal.SCHEDULER_DENY_MESSAGE).toMatch(/do not persist between turns/i);
    expect(_internal.SCHEDULER_DENY_MESSAGE).toMatch(/poll in the foreground/i);
    expect(_internal.SCHEDULER_DENY_MESSAGE).toMatch(/never end a turn saying you will check back/i);
  });

  it('leaves the read-only / cleanup cron tools alone', async () => {
    for (const toolName of ['CronList', 'CronDelete']) {
      expect(await backgroundTaskPreToolUseHook({ tool_name: toolName, tool_input: {} })).toEqual(
        {},
      );
    }
  });

  it('is a no-op for an arbitrary other tool', async () => {
    const out = await backgroundTaskPreToolUseHook({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/x' },
    });

    expect(out).toEqual({});
  });

  it('is a no-op when tool_name is absent', async () => {
    const out = await backgroundTaskPreToolUseHook({ tool_input: { run_in_background: true } });
    expect(out).toEqual({});
  });
});
