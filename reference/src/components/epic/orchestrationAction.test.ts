import { describe, it, expect } from 'vitest';
import { orchestrationStatus, primaryOrchestrationAction } from './orchestrationAction';
import type { EpicRow, TaskRow } from '@shared/types/db';

function epic(overrides: Partial<EpicRow> = {}): EpicRow {
  return {
    id: 7,
    stories_complete: 1,
    review_complete: 1,
    orchestration_active: 0,
    orchestration_blocked: 0,
    orchestration_blocked_reason: null,
    ...overrides,
  } as EpicRow;
}

function ticket(id: number, status: TaskRow['status'] = 'pending'): TaskRow {
  return { id, status } as TaskRow;
}

describe('orchestrationStatus', () => {
  it('is not started before the flag is set', () => {
    expect(orchestrationStatus(epic(), [ticket(1)])).toBe('not_started');
  });

  it('is running while the flag is set — whatever the dormant orchestrator last did', () => {
    expect(orchestrationStatus(epic({ orchestration_active: 1 }), [ticket(1)])).toBe('running');
  });

  it('is paused on a block, which keeps the epic under orchestration', () => {
    expect(
      orchestrationStatus(epic({ orchestration_active: 1, orchestration_blocked: 1 }), [ticket(1)]),
    ).toBe('paused');
  });

  it('is completed once every ticket has merged and the orchestrator has left', () => {
    expect(orchestrationStatus(epic(), [ticket(1, 'completed'), ticket(2, 'completed')])).toBe(
      'completed',
    );
  });

  it('is not completed with no tickets at all', () => {
    expect(orchestrationStatus(epic(), [])).toBe('not_started');
  });

  it('stays running until the orchestrator leaves, even with every ticket merged', () => {
    // The final ticket merged; the orchestrator's closing turn has not yet
    // cleared the flag.
    expect(
      orchestrationStatus(epic({ orchestration_active: 1 }), [ticket(1, 'completed')]),
    ).toBe('running');
  });
});

describe('primaryOrchestrationAction', () => {
  it('offers Start once the tickets are approved and reviewed', () => {
    expect(primaryOrchestrationAction(epic(), [ticket(1)])).toEqual({
      action: 'start',
      label: 'Start orchestration',
      pendingLabel: 'Starting…',
      disabledReason: null,
    });
  });

  it('holds Start behind the stories sign-off first', () => {
    expect(
      primaryOrchestrationAction(epic({ stories_complete: 0, review_complete: 0 }), [ticket(1)])
        ?.disabledReason,
    ).toMatch(/approve the epic tickets first/);
  });

  it('holds Start behind the specification review, and names the backstop', () => {
    expect(
      primaryOrchestrationAction(epic({ review_complete: 0 }), [ticket(1)])?.disabledReason,
    ).toMatch(/specification review first — or mark it complete/);
  });

  it('holds Start when there is nothing to orchestrate', () => {
    expect(primaryOrchestrationAction(epic(), [])?.disabledReason).toMatch(/no tickets/);
  });

  it('offers Pause while running', () => {
    const action = primaryOrchestrationAction(epic({ orchestration_active: 1 }), [ticket(1)]);
    expect(action?.action).toBe('pause');
    expect(action?.disabledReason).toBeNull();
  });

  it('offers Resume while paused', () => {
    const action = primaryOrchestrationAction(
      epic({ orchestration_active: 1, orchestration_blocked: 1 }),
      [ticket(1)],
    );
    expect(action?.action).toBe('resume');
    expect(action?.disabledReason).toBeNull();
  });

  // The final pull request is the Delivery section's, not orchestration's:
  // once every ticket has merged this stage is over and offers nothing.
  it('offers nothing once every ticket has merged', () => {
    expect(primaryOrchestrationAction(epic(), [ticket(1, 'completed')])).toBeNull();
  });
});
