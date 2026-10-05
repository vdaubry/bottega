import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockConversationGetById, mockRunByConversation, mockEpicGetById, mockWritableDirs } =
  vi.hoisted(() => ({
    mockConversationGetById: vi.fn(),
    mockRunByConversation: vi.fn(),
    mockEpicGetById: vi.fn(),
    mockWritableDirs: vi.fn(),
  }));

vi.mock('../../database/conversations.js', () => ({
  conversationsDb: { getById: mockConversationGetById },
}));

vi.mock('../../database/epics.js', () => ({
  epicAgentRunsDb: { getByConversationId: mockRunByConversation },
  epicsDb: { getById: mockEpicGetById },
}));

vi.mock('./epicArchive.js', () => ({
  getEpicStageWritableDirs: mockWritableDirs,
}));

import {
  buildEpicDocsWriteGate,
  epicDocsWriteGateForConversation,
  epicDisallowedToolsForConversation,
} from './epicDocsWriteGate.js';
import {
  EPIC_ARCHITECTURE_DISALLOWED_TOOLS,
  EPIC_ORCHESTRATOR_DISALLOWED_TOOLS,
  EPIC_PR_REVIEW_DISALLOWED_TOOLS,
  EPIC_SPECIFICATION_DISALLOWED_TOOLS,
} from './epicAgents.js';

const DOCS = '/archive/projects/3/epics/epic-7/docs';
const ARCHITECTURE = '/archive/projects/3/epics/epic-7/architecture';
const REVIEW = '/archive/projects/3/epics/epic-7/review';
const SPEC = '/archive/projects/3/epics/epic-7/spec';
const REPO = '/repos/nimbus';

function decisionOf(output: {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
}) {
  return {
    decision: output.hookSpecificOutput?.permissionDecision,
    reason: output.hookSpecificOutput?.permissionDecisionReason ?? '',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWritableDirs.mockReturnValue([DOCS]);
});

describe('buildEpicDocsWriteGate', () => {
  const gate = buildEpicDocsWriteGate([DOCS]);

  it('allows a write inside the epic documents directory', async () => {
    const output = await gate({
      tool_name: 'Write',
      tool_input: { file_path: `${DOCS}/00-master.md` },
      cwd: REPO,
    });

    expect(output).toEqual({});
  });

  it('allows a write in a subdirectory of it', async () => {
    const output = await gate({
      tool_name: 'Edit',
      tool_input: { file_path: `${DOCS}/appendices/01-api.md` },
      cwd: REPO,
    });

    expect(output).toEqual({});
  });

  it('denies a write into the repository', async () => {
    const { decision, reason } = decisionOf(
      await gate({
        tool_name: 'Write',
        tool_input: { file_path: `${REPO}/src/pricing.ts` },
        cwd: REPO,
      }),
    );

    expect(decision).toBe('deny');
    expect(reason).toContain(`${REPO}/src/pricing.ts`);
    expect(reason).toContain(DOCS);
  });

  it('denies traversal back out of the documents directory', async () => {
    const { decision } = decisionOf(
      await gate({
        tool_name: 'Write',
        tool_input: { file_path: `${DOCS}/../spec/leak.md` },
        cwd: REPO,
      }),
    );

    expect(decision).toBe('deny');
  });

  it('denies a sibling directory whose name merely starts the same', async () => {
    const { decision } = decisionOf(
      await gate({
        tool_name: 'Write',
        tool_input: { file_path: `${DOCS}-backup/00-master.md` },
        cwd: REPO,
      }),
    );

    expect(decision).toBe('deny');
  });

  it('denies a relative path — it resolves against the repo checkout', async () => {
    const { decision, reason } = decisionOf(
      await gate({ tool_name: 'Write', tool_input: { file_path: '00-master.md' }, cwd: REPO }),
    );

    expect(decision).toBe('deny');
    expect(reason).toContain(DOCS);
  });

  it('denies a write with no file_path rather than letting it through', async () => {
    const { decision } = decisionOf(
      await gate({ tool_name: 'Write', tool_input: {}, cwd: REPO }),
    );

    expect(decision).toBe('deny');
  });

  it('contains NotebookEdit by its notebook_path, like file_path for the others', async () => {
    // NotebookEdit is on for the document stages (nothing is denied), so the
    // gate must read the parameter it actually uses.
    const inside = await gate({
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: `${DOCS}/analysis.ipynb` },
      cwd: REPO,
    });
    expect(inside).toEqual({});

    const { decision, reason } = decisionOf(
      await gate({
        tool_name: 'NotebookEdit',
        tool_input: { notebook_path: `${REPO}/notebooks/analysis.ipynb` },
        cwd: REPO,
      }),
    );
    expect(decision).toBe('deny');
    expect(reason).toContain(DOCS);
  });

  it.each(['Read', 'Grep', 'Glob', 'AskUserQuestion', 'mcp__bottega__mark_stage_complete'])(
    'ignores %s',
    async (toolName) => {
      const output = await gate({
        tool_name: toolName,
        tool_input: { file_path: `${REPO}/src/pricing.ts` },
        cwd: REPO,
      });

      expect(output).toEqual({});
    },
  );

  it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])('gates %s', async (toolName) => {
    const { decision } = decisionOf(
      await gate({
        tool_name: toolName,
        tool_input: { file_path: `${REPO}/src/pricing.ts` },
        cwd: REPO,
      }),
    );

    expect(decision).toBe('deny');
  });
});

describe('epicDocsWriteGateForConversation', () => {
  it('builds a gate rooted at docs/ for a specification conversation', () => {
    mockConversationGetById.mockReturnValue({ id: 5, task_id: null, epic_id: 7 });
    mockRunByConversation.mockReturnValue({ id: 9, agent_type: 'epic-specification' });
    mockEpicGetById.mockReturnValue({ id: 7, project_id: 3 });

    expect(epicDocsWriteGateForConversation(5)).toBeTypeOf('function');
    expect(mockWritableDirs).toHaveBeenCalledWith('epic-specification', 3, 7);
  });

  it('builds a gate rooted at architecture/ for an architecture conversation', async () => {
    mockConversationGetById.mockReturnValue({ id: 5, task_id: null, epic_id: 7 });
    mockRunByConversation.mockReturnValue({ id: 9, agent_type: 'epic-architecture' });
    mockEpicGetById.mockReturnValue({ id: 7, project_id: 3 });
    mockWritableDirs.mockReturnValue([ARCHITECTURE]);

    const gate = epicDocsWriteGateForConversation(5);
    expect(gate).toBeTypeOf('function');
    expect(mockWritableDirs).toHaveBeenCalledWith('epic-architecture', 3, 7);

    // The fence is the stage's own directory: the specification's docs/ and
    // the repository are both out of bounds.
    const inside = await gate!({
      tool_name: 'Write',
      tool_input: { file_path: `${ARCHITECTURE}/architecture.md` },
      cwd: REPO,
    });
    expect(inside).toEqual({});
    for (const outside of [`${DOCS}/00-master.md`, `${REPO}/src/pricing.ts`]) {
      const { decision, reason } = decisionOf(
        await gate!({ tool_name: 'Write', tool_input: { file_path: outside }, cwd: REPO }),
      );
      expect(decision).toBe('deny');
      expect(reason).toContain(ARCHITECTURE);
    }
  });

  it('returns null for a task conversation', () => {
    mockConversationGetById.mockReturnValue({ id: 5, task_id: 12, epic_id: null });

    expect(epicDocsWriteGateForConversation(5)).toBeNull();
  });

  it('returns null for an epic conversation with no linked run', () => {
    mockConversationGetById.mockReturnValue({ id: 5, task_id: null, epic_id: 7 });
    mockRunByConversation.mockReturnValue(undefined);

    expect(epicDocsWriteGateForConversation(5)).toBeNull();
  });

  it('fences the specification review inside its four directories — report, spec, architecture, docs', async () => {
    mockConversationGetById.mockReturnValue({ id: 5, task_id: null, epic_id: 7 });
    mockRunByConversation.mockReturnValue({ id: 9, agent_type: 'epic-spec-review' });
    mockEpicGetById.mockReturnValue({ id: 7, project_id: 3 });
    mockWritableDirs.mockReturnValue([REVIEW, SPEC, ARCHITECTURE, DOCS]);

    const gate = epicDocsWriteGateForConversation(5);
    expect(gate).toBeTypeOf('function');
    expect(mockWritableDirs).toHaveBeenCalledWith('epic-spec-review', 3, 7);

    // It corrects every document level it reviews — the functional spec
    // included — and writes its own report; the repository stays out of bounds.
    for (const allowed of [
      `${REVIEW}/review.md`,
      `${SPEC}/pricing-specification.md`,
      `${ARCHITECTURE}/architecture.md`,
      `${DOCS}/03-draws.md`,
    ]) {
      const out = await gate!({ tool_name: 'Edit', tool_input: { file_path: allowed }, cwd: REPO });
      expect(decisionOf(out).decision, allowed).toBeUndefined();
    }
    for (const denied of [`${REPO}/app/models/x.rb`, '/archive/projects/3/epics/epic-8/spec/other.md']) {
      const out = await gate!({ tool_name: 'Edit', tool_input: { file_path: denied }, cwd: REPO });
      expect(decisionOf(out).decision, denied).toBe('deny');
      expect(decisionOf(out).reason).toContain(REVIEW);
      expect(decisionOf(out).reason).toContain(SPEC);
      expect(decisionOf(out).reason).toContain(DOCS);
    }
  });

  it('returns null for a stage that writes nothing (stories)', () => {
    mockConversationGetById.mockReturnValue({ id: 5, task_id: null, epic_id: 7 });
    mockRunByConversation.mockReturnValue({ id: 9, agent_type: 'epic-stories' });
    mockEpicGetById.mockReturnValue({ id: 7, project_id: 3 });
    mockWritableDirs.mockReturnValue([]);

    expect(epicDocsWriteGateForConversation(5)).toBeNull();
    expect(mockWritableDirs).toHaveBeenCalledWith('epic-stories', 3, 7);
  });

  it('fences the QA scenario writer inside qa/ — its writes flow through the QA tools anyway', async () => {
    mockConversationGetById.mockReturnValue({ id: 5, task_id: null, epic_id: 7 });
    mockRunByConversation.mockReturnValue({ id: 9, agent_type: 'epic-qa-scenarios' });
    mockEpicGetById.mockReturnValue({ id: 7, project_id: 3 });
    const QA = '/archive/projects/3/epics/epic-7/qa';
    mockWritableDirs.mockReturnValue([QA]);

    const gate = epicDocsWriteGateForConversation(5);
    expect(gate).toBeTypeOf('function');
    expect(mockWritableDirs).toHaveBeenCalledWith('epic-qa-scenarios', 3, 7);

    const inside = await gate!({
      tool_name: 'Write',
      tool_input: { file_path: `${QA}/scenarios.csv` },
      cwd: REPO,
    });
    expect(inside).toEqual({});
    const { decision } = decisionOf(
      await gate!({
        tool_name: 'Write',
        tool_input: { file_path: `${REPO}/src/pricing.ts` },
        cwd: REPO,
      }),
    );
    expect(decision).toBe('deny');
  });

  it('returns null for QA execution — it records results through record_qa_results, never file writers', () => {
    mockConversationGetById.mockReturnValue({ id: 5, task_id: null, epic_id: 7 });
    mockRunByConversation.mockReturnValue({ id: 9, agent_type: 'epic-qa-execution' });
    mockEpicGetById.mockReturnValue({ id: 7, project_id: 3 });
    mockWritableDirs.mockReturnValue([]);

    expect(epicDocsWriteGateForConversation(5)).toBeNull();
    expect(mockWritableDirs).toHaveBeenCalledWith('epic-qa-execution', 3, 7);
  });

  it('returns null when the linked run is a task agent, not an epic stage', () => {
    mockConversationGetById.mockReturnValue({ id: 5, task_id: null, epic_id: 7 });
    mockRunByConversation.mockReturnValue({ id: 9, agent_type: 'planification' });

    expect(epicDocsWriteGateForConversation(5)).toBeNull();
    expect(mockWritableDirs).not.toHaveBeenCalled();
  });

  it('returns null for the PR reviewer — it writes code in its worktree, not archive documents', () => {
    mockConversationGetById.mockReturnValue({ id: 5, task_id: null, epic_id: 7 });
    mockRunByConversation.mockReturnValue({ id: 9, agent_type: 'epic-pr-review', ticket_task_id: 42 });
    mockEpicGetById.mockReturnValue({ id: 7, project_id: 3 });
    mockWritableDirs.mockReturnValue([]);

    expect(epicDocsWriteGateForConversation(5)).toBeNull();
    expect(mockWritableDirs).toHaveBeenCalledWith('epic-pr-review', 3, 7);
  });

  it('returns null when the epic row has vanished', () => {
    mockConversationGetById.mockReturnValue({ id: 5, task_id: null, epic_id: 7 });
    mockRunByConversation.mockReturnValue({ id: 9, agent_type: 'epic-specification' });
    mockEpicGetById.mockReturnValue(undefined);

    expect(epicDocsWriteGateForConversation(5)).toBeNull();
  });
});

describe('epicDisallowedToolsForConversation', () => {
  it("returns the orchestrator's catalog for an orchestrator conversation", () => {
    mockConversationGetById.mockReturnValue({ id: 5, task_id: null, epic_id: 7 });
    mockRunByConversation.mockReturnValue({ id: 9, agent_type: 'epic-orchestrator' });

    const tools = epicDisallowedToolsForConversation(5);
    expect(tools).toEqual(EPIC_ORCHESTRATOR_DISALLOWED_TOOLS);
    // The orchestrator carries the full surface: it has to be able to check a
    // blocked ticket's claim and repair the environment behind it.
    expect(tools).toEqual([]);
  });

  it("returns the PR reviewer's catalog — the full shell, only questions denied", () => {
    mockConversationGetById.mockReturnValue({ id: 5, task_id: null, epic_id: 7 });
    mockRunByConversation.mockReturnValue({ id: 9, agent_type: 'epic-pr-review' });

    const tools = epicDisallowedToolsForConversation(5);
    expect(tools).toEqual(EPIC_PR_REVIEW_DISALLOWED_TOOLS);
    expect(tools).toEqual(['AskUserQuestion']);
  });

  it("returns the specification stage's catalog for a specification conversation", () => {
    mockConversationGetById.mockReturnValue({ id: 5, task_id: null, epic_id: 7 });
    mockRunByConversation.mockReturnValue({ id: 9, agent_type: 'epic-specification' });

    expect(epicDisallowedToolsForConversation(5)).toEqual(EPIC_SPECIFICATION_DISALLOWED_TOOLS);
  });

  it("returns the architecture stage's catalog — native writers denied, Bash on", () => {
    mockConversationGetById.mockReturnValue({ id: 5, task_id: null, epic_id: 7 });
    mockRunByConversation.mockReturnValue({ id: 9, agent_type: 'epic-architecture' });

    const tools = epicDisallowedToolsForConversation(5);
    expect(tools).toEqual(EPIC_ARCHITECTURE_DISALLOWED_TOOLS);
    expect(tools).toEqual(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
  });

  it('returns undefined for a task conversation', () => {
    mockConversationGetById.mockReturnValue({ id: 5, task_id: 12, epic_id: null });

    expect(epicDisallowedToolsForConversation(5)).toBeUndefined();
  });

  it('returns undefined for an epic conversation with no linked run', () => {
    mockConversationGetById.mockReturnValue({ id: 5, task_id: null, epic_id: 7 });
    mockRunByConversation.mockReturnValue(undefined);

    expect(epicDisallowedToolsForConversation(5)).toBeUndefined();
  });

  it('returns undefined when the linked run is not an epic agent', () => {
    mockConversationGetById.mockReturnValue({ id: 5, task_id: null, epic_id: 7 });
    mockRunByConversation.mockReturnValue({ id: 9, agent_type: 'planification' });

    expect(epicDisallowedToolsForConversation(5)).toBeUndefined();
  });
});
