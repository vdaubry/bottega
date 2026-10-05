import { describe, it, expect, beforeEach, vi } from 'vitest';

// The scope module is a dispatcher since architecture-v2 step 5: each owner
// domain resolves its own scope through the adapter it registered. The
// domain-specific cwd rules are covered in the adapters' own tests.
import {
  resolveConversationScope,
  resolveScopeFromConversation,
  targetFromConversation,
} from './conversationScope.js';
import { registerOwnerAdapter } from './ownerAdapters.js';
import type { ConversationOwnerAdapter } from './ownerAdapters.js';

const resolveTaskScope = vi.fn();
const resolveEpicScope = vi.fn();
const resolveTaskOwner = vi.fn();
const resolveEpicOwner = vi.fn();

function fake(kind: 'task' | 'epic', resolveScope: unknown, resolveOwner: unknown) {
  return { kind, resolveScope, resolveOwner } as unknown as ConversationOwnerAdapter;
}

beforeEach(() => {
  vi.clearAllMocks();
  registerOwnerAdapter(fake('task', resolveTaskScope, resolveTaskOwner));
  registerOwnerAdapter(fake('epic', resolveEpicScope, resolveEpicOwner));
});

describe('targetFromConversation', () => {
  it('maps the owner columns onto a target', () => {
    expect(targetFromConversation({ id: 1, task_id: 3, epic_id: null } as never)).toEqual({
      kind: 'task',
      taskId: 3,
    });
    expect(targetFromConversation({ id: 2, task_id: null, epic_id: 42 } as never)).toEqual({
      kind: 'epic',
      epicId: 42,
    });
  });

  it('throws for a conversation with no owner', () => {
    expect(() =>
      targetFromConversation({ id: 3, task_id: null, epic_id: null } as never),
    ).toThrow(/neither task_id nor epic_id/);
  });
});

describe('resolveConversationScope', () => {
  it('dispatches to the owner-kind adapter with the whole target', async () => {
    resolveTaskScope.mockResolvedValue({ kind: 'task', cwd: '/wt' });
    await expect(resolveConversationScope({ kind: 'task', taskId: 3 })).resolves.toEqual({
      kind: 'task',
      cwd: '/wt',
    });
    expect(resolveTaskScope).toHaveBeenCalledWith({ kind: 'task', taskId: 3 });

    resolveEpicScope.mockResolvedValue({ kind: 'epic', cwd: '/repo' });
    await resolveConversationScope({ kind: 'epic', epicId: 42, worktreeTaskId: 3 });
    expect(resolveEpicScope).toHaveBeenCalledWith({
      kind: 'epic',
      epicId: 42,
      worktreeTaskId: 3,
    });
  });
});

describe('resolveScopeFromConversation', () => {
  it('dispatches by owner_kind', () => {
    resolveEpicOwner.mockReturnValue({ taskId: null, epicId: 42, projectId: 7 });
    const conversation = { id: 1, owner_kind: 'epic', task_id: null, epic_id: 42 } as never;

    expect(resolveScopeFromConversation(conversation)).toEqual({
      taskId: null,
      epicId: 42,
      projectId: 7,
    });
    expect(resolveEpicOwner).toHaveBeenCalledWith(conversation);
    expect(resolveTaskOwner).not.toHaveBeenCalled();
  });
});
