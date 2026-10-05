import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetById, mockSetStageComplete } = vi.hoisted(() => ({
  mockGetById: vi.fn(),
  mockSetStageComplete: vi.fn(),
}));

// Capture tool definitions instead of standing up a real MCP server — the
// SDK's tool() is a plain definition builder; what we test is our handlers.
// (Same harness as atlas/mcpServer.test.ts.)
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (
    name: string,
    description: string,
    inputSchema: unknown,
    handler: (args: unknown) => Promise<unknown>,
  ) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: (opts: { name: string; tools: unknown[] }) => ({
    type: 'sdk',
    name: opts.name,
    __tools: opts.tools,
  }),
}));

vi.mock('../../../database/epics.js', () => ({
  epicsDb: { getById: mockGetById, setStageComplete: mockSetStageComplete },
}));

import { buildBottegaMcpServer, toolsFor } from './mcpServer.js';
import type { EpicAgentType } from '@shared/types/db';

interface CapturedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>;
}

const EPIC = {
  id: 7,
  project_id: 3,
  status: 'active',
  architecture_complete: 1,
  specs_complete: 0,
  stories_complete: 0,
};

const broadcast = vi.fn();

function getTools(agentType: EpicAgentType): Record<string, CapturedTool> {
  const server = buildBottegaMcpServer({
    epicId: 7,
    agentType,
    conversationId: 5,
    userId: 1,
    broadcastToEpicSubscribersFn: broadcast,
  }) as { name: string; __tools: CapturedTool[] };
  expect(server.name).toBe('bottega');
  return Object.fromEntries(server.__tools.map((t) => [t.name, t]));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetById.mockReturnValue({ ...EPIC });
  mockSetStageComplete.mockReturnValue({ ...EPIC, specs_complete: 1 });
});

describe('per-agent-type catalog', () => {
  it('gives the specification stage exactly mark_stage_complete', () => {
    expect(Object.keys(getTools('epic-specification'))).toEqual(['mark_stage_complete']);
  });

  it('gives the stories stage the ticket verbs plus its own sign-off', () => {
    expect(Object.keys(getTools('epic-stories'))).toEqual([
      'create_task',
      'list_epic_tasks',
      'update_task',
      'delete_task',
      'mark_stage_complete',
    ]);
  });

  it('gives the specification review the stories catalog plus its own sign-off', () => {
    // It corrects the tickets the user agrees need it — the third of the three
    // levels it keeps consistent (the other two it edits with its writers).
    expect(Object.keys(getTools('epic-spec-review'))).toEqual([
      'create_task',
      'list_epic_tasks',
      'update_task',
      'delete_task',
      'mark_stage_complete',
    ]);
  });

  it('gives the architecture stage exactly mark_stage_complete — its output is the files it writes', () => {
    expect(Object.keys(getTools('epic-architecture'))).toEqual(['mark_stage_complete']);
    expect(
      toolsFor({ epicId: 7, agentType: 'epic-architecture', conversationId: 5 }),
    ).toHaveLength(1);
  });

  it('gives the orchestrator the drive-a-ticket catalog and no sign-off — implementation has no flag', () => {
    expect(Object.keys(getTools('epic-orchestrator'))).toEqual([
      'get_epic_state',
      'start_planification',
      'get_pending_question',
      'answer_question',
      'read_task_plan',
      'send_feedback_to_planification',
      'approve_plan_and_start_implementation',
      'get_task_progress',
      'read_agent_transcript',
      'resume_ticket',
      'start_pr_review',
      'open_epic_pr',
      'block_epic',
      'notify_user',
    ]);
  });

  it('gives the PR reviewer merge and block — the rest of its work is its shell', () => {
    expect(Object.keys(getTools('epic-pr-review'))).toEqual(['merge_task', 'block_epic']);
  });

  it('keeps every stage out of the others\' verbs', () => {
    // The isolation that makes the catalog worth having: a specification agent
    // cannot create tickets, a stories agent cannot merge a pull request, and
    // the orchestrator cannot merge one either — only the reviewer can.
    expect(Object.keys(getTools('epic-specification'))).not.toContain('create_task');
    expect(Object.keys(getTools('epic-stories'))).not.toContain('merge_task');
    expect(Object.keys(getTools('epic-orchestrator'))).not.toContain('create_task');
    expect(Object.keys(getTools('epic-orchestrator'))).not.toContain('mark_stage_complete');
    expect(Object.keys(getTools('epic-orchestrator'))).not.toContain('merge_task');
    expect(Object.keys(getTools('epic-pr-review'))).not.toContain('start_planification');
    expect(Object.keys(getTools('epic-pr-review'))).not.toContain('mark_stage_complete');
    expect(Object.keys(getTools('epic-spec-review'))).not.toContain('merge_task');
    expect(Object.keys(getTools('epic-spec-review'))).not.toContain('start_planification');
  });

  it('gives read_agent_transcript to the supervisors and to nobody else', () => {
    // Reading another agent's turn is a supervisor's power, not a peer's: the
    // orchestrator and the QA fix mission debug the tickets they drive, and no
    // other stage has any business inside a conversation that is not its own.
    expect(Object.keys(getTools('epic-orchestrator'))).toContain('read_agent_transcript');
    for (const agentType of [
      'epic-architecture',
      'epic-specification',
      'epic-stories',
      'epic-spec-review',
      'epic-pr-review',
    ] as const) {
      expect(Object.keys(getTools(agentType))).not.toContain('read_agent_transcript');
    }
  });

  it('names the stage the conversation owns in the tool description', () => {
    expect(getTools('epic-architecture').mark_stage_complete!.description).toContain(
      "'architecture'",
    );
    expect(getTools('epic-specification').mark_stage_complete!.description).toContain(
      "'specification'",
    );
    expect(getTools('epic-stories').mark_stage_complete!.description).toContain("'stories'");
    expect(getTools('epic-spec-review').mark_stage_complete!.description).toContain("'review'");
  });

  it("tells the specification reviewer its sign-off is the user's approval of the corrected state", () => {
    const description = getTools('epic-spec-review').mark_stage_complete!.description;
    expect(description).toContain('approved by the user');
    expect(description).toContain('every finding the user approved has been applied');
    expect(description).toContain('explicit approval');
    expect(description).toContain('never while an approved fix is still unapplied');
  });

  it('takes only the stage — the output is the hand-off, there is no summary channel', () => {
    const schema = getTools('epic-specification').mark_stage_complete!.inputSchema;
    expect(Object.keys(schema)).toEqual(['stage']);
  });
});

describe('mark_stage_complete', () => {
  it('flips the flag and announces the row change', async () => {
    const result = await getTools('epic-specification').mark_stage_complete!.handler({
      stage: 'specification',
    });

    expect(result.isError).toBeUndefined();
    expect(mockSetStageComplete).toHaveBeenCalledWith(7, 'specs');
    expect(broadcast).toHaveBeenCalledWith(7, {
      type: 'epic-updated',
      epic: {
        id: 7,
        status: 'active',
        architecture_complete: 1,
        specs_complete: 1,
        stories_complete: 0,
      },
    });
    expect(result.content[0]!.text).toBe("Stage 'specification' marked complete for epic 7.");
  });

  it("flips the review flag on the reviewer's own call", async () => {
    mockSetStageComplete.mockReturnValue({ ...EPIC, stories_complete: 1, review_complete: 1 });

    const result = await getTools('epic-spec-review').mark_stage_complete!.handler({
      stage: 'review',
    });

    expect(result.isError).toBeUndefined();
    expect(mockSetStageComplete).toHaveBeenCalledWith(7, 'review');
    expect(broadcast).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: 'epic-updated',
        epic: expect.objectContaining({ review_complete: 1 }),
      }),
    );
  });

  it('refuses to complete another stage', async () => {
    const result = await getTools('epic-specification').mark_stage_complete!.handler({
      stage: 'stories',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("can only complete that stage");
    expect(mockSetStageComplete).not.toHaveBeenCalled();
  });

  it('refuses when the stage is already complete', async () => {
    mockGetById.mockReturnValue({ ...EPIC, specs_complete: 1 });

    const result = await getTools('epic-specification').mark_stage_complete!.handler({
      stage: 'specification',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('already marked complete');
    expect(mockSetStageComplete).not.toHaveBeenCalled();
  });

  it('reports a deleted epic instead of throwing', async () => {
    mockGetById.mockReturnValue(undefined);

    const result = await getTools('epic-specification').mark_stage_complete!.handler({
      stage: 'specification',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('no longer exists');
  });

  it('turns an unexpected failure into an error result the model can read', async () => {
    mockSetStageComplete.mockImplementation(() => {
      throw new Error('database is locked');
    });

    const result = await getTools('epic-specification').mark_stage_complete!.handler({
      stage: 'specification',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('database is locked');
  });
});

describe('the QA catalogs', () => {
  // The document/QA builders touch the archive at build time (`ensureEpicDirs`),
  // so these tests point the archive root at a temp dir.
  let archiveRoot: string;

  beforeEach(async () => {
    const [fs, os, path] = [await import('fs'), await import('os'), await import('path')];
    archiveRoot = fs.default.mkdtempSync(
      path.default.join(os.default.tmpdir(), 'bottega-mcp-qa-'),
    );
    process.env.BOTTEGA_ARCHIVE_ROOT = archiveRoot;
  });

  afterEach(async () => {
    const fs = await import('fs');
    delete process.env.BOTTEGA_ARCHIVE_ROOT;
    fs.default.rmSync(archiveRoot, { recursive: true, force: true });
  });

  function getToolsWithProject(agentType: EpicAgentType): Record<string, CapturedTool> {
    const server = buildBottegaMcpServer({
      projectId: 3,
      epicId: 7,
      agentType,
      conversationId: 5,
      userId: 1,
      broadcastToEpicSubscribersFn: broadcast,
    }) as { name: string; __tools: CapturedTool[] };
    return Object.fromEntries(server.__tools.map((t) => [t.name, t]));
  }

  it('gives the scenario writer archive reads, the structured book writers, and its own sign-off — never the generic document writers', () => {
    expect(Object.keys(getToolsWithProject('epic-qa-scenarios'))).toEqual([
      'list_epic_documents',
      'read_epic_document',
      'write_qa_scenarios',
      'delete_qa_scenarios',
      'mark_stage_complete',
    ]);
  });

  it('gives the executor archive reads and record_qa_results — no sign-off (it owns no stage) and no book writers', () => {
    const names = Object.keys(getToolsWithProject('epic-qa-execution'));
    expect(names).toEqual(['list_epic_documents', 'read_epic_document', 'record_qa_results']);
    expect(names).not.toContain('mark_stage_complete');
    expect(names).not.toContain('write_qa_scenarios');
  });

  it('gives the QA fix mission the supervision verbs, its fix-ticket verbs, merge, archive reads and record_qa_results', () => {
    const names = Object.keys(getToolsWithProject('epic-qa-fix'));
    expect(names).toEqual([
      'get_epic_state',
      'start_planification',
      'get_pending_question',
      'answer_question',
      'read_task_plan',
      'send_feedback_to_planification',
      'approve_plan_and_start_implementation',
      'get_task_progress',
      'read_agent_transcript',
      'resume_ticket',
      'notify_user',
      'create_fix_ticket',
      'adopt_fix_ticket',
      'merge_task',
      'list_epic_documents',
      'read_epic_document',
      'record_qa_results',
    ]);
    // The orchestration-only verbs stay out: the mission reviews and merges
    // the PR itself, and never touches the orchestration flags.
    expect(names).not.toContain('start_pr_review');
    expect(names).not.toContain('open_epic_pr');
    expect(names).not.toContain('block_epic');
    expect(names).not.toContain('write_qa_scenarios');
    expect(names).not.toContain('mark_stage_complete');
  });

  it('degrades both QA catalogs to empty without a projectId, like the document stages', () => {
    expect(toolsFor({ epicId: 7, agentType: 'epic-qa-scenarios', conversationId: 5 })).toHaveLength(0);
    expect(toolsFor({ epicId: 7, agentType: 'epic-qa-execution', conversationId: 5 })).toHaveLength(0);
    expect(toolsFor({ epicId: 7, agentType: 'epic-qa-fix', conversationId: 5 })).toHaveLength(0);
  });

  it("ties the writer's sign-off to the user's explicit approval of the book", () => {
    const description = getToolsWithProject('epic-qa-scenarios').mark_stage_complete!.description;
    expect(description).toContain("'qa'");
    expect(description).toContain('approved the scenario book');
    expect(description).toContain('a message with no feedback is not approval');
  });
});
