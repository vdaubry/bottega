import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetWithProject, mockUpsert, mockGetWorkspaceForTask, mockSendAtlasEvent, mockGetAtlasSubscriberCount } =
  vi.hoisted(() => ({
    mockGetWithProject: vi.fn(),
    mockUpsert: vi.fn(),
    mockGetWorkspaceForTask: vi.fn(),
    mockSendAtlasEvent: vi.fn(),
    mockGetAtlasSubscriberCount: vi.fn(),
  }));

// Capture tool definitions instead of standing up a real MCP server — the
// SDK's tool() is a plain definition builder; what we test is our handlers.
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

vi.mock('../../database/db.js', () => ({
  tasksDb: { getWithProject: mockGetWithProject },
  taskArtifactsDb: { upsert: mockUpsert },
}));

vi.mock('./workspace.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./workspace.js')>();
  return {
    ...original,
    getWorkspaceForTask: mockGetWorkspaceForTask,
  };
});

vi.mock('./bridge.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./bridge.js')>();
  return {
    ...original,
    sendAtlasEvent: mockSendAtlasEvent,
    getAtlasSubscriberCount: mockGetAtlasSubscriberCount,
  };
});

import { buildAtlasMcpServer } from './mcpServer.js';
import { WorkspaceError } from './workspace.js';

interface CapturedTool {
  name: string;
  description: string;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>;
}

function getTools(): Record<string, CapturedTool> {
  const server = buildAtlasMcpServer({ taskId: 42, userId: 1 }) as unknown as {
    name: string;
    __tools: CapturedTool[];
  };
  expect(server.name).toBe('code-atlas');
  return Object.fromEntries(server.__tools.map((t) => [t.name, t]));
}

const FILES: Record<string, { path: string; content: string; lineCount: number }> = {
  'src/index.ts': { path: 'src/index.ts', content: 'a\nb\nc', lineCount: 3 },
  'README.md': { path: 'README.md', content: '# hi', lineCount: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetWithProject.mockReturnValue({ id: 42, repo_folder_path: '/repos/demo', subproject_path: null });
  mockGetWorkspaceForTask.mockResolvedValue({
    readFile: vi.fn(async (relPath: string) => {
      const file = FILES[relPath];
      if (!file) throw new WorkspaceError(`File not found: ${relPath}`);
      return file;
    }),
  });
  mockGetAtlasSubscriberCount.mockReturnValue(1);
  mockSendAtlasEvent.mockResolvedValue(undefined);
});

describe('open_file', () => {
  it('pushes the file to the Explore view and reports success', async () => {
    const { open_file } = getTools();
    const result = await open_file!.handler({ path: 'src/index.ts', line: 2 });

    expect(mockSendAtlasEvent).toHaveBeenCalledWith(42, {
      type: 'atlas-open-file',
      path: 'src/index.ts',
      content: 'a\nb\nc',
      line: 2,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe('Opened src/index.ts (3 lines), scrolled to line 2');
  });

  it('rejects out-of-range lines without touching the UI', async () => {
    const { open_file } = getTools();
    const result = await open_file!.handler({ path: 'src/index.ts', line: 99 });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Invalid line 99');
    expect(result.content[0]!.text).toContain('valid range 1-3');
    expect(mockSendAtlasEvent).not.toHaveBeenCalled();
  });

  it('returns a polite no-op when no Explore view is open', async () => {
    mockGetAtlasSubscriberCount.mockReturnValue(0);
    const { open_file } = getTools();
    const result = await open_file!.handler({ path: 'src/index.ts' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('No Explore view is open');
    expect(mockSendAtlasEvent).not.toHaveBeenCalled();
  });

  it('surfaces workspace errors (missing file) as tool errors', async () => {
    const { open_file } = getTools();
    const result = await open_file!.handler({ path: 'nope.ts' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('File not found: nope.ts');
  });

  it('resolves the workspace lazily per call (worktrees can appear between turns)', async () => {
    const { open_file } = getTools();
    await open_file!.handler({ path: 'src/index.ts' });
    await open_file!.handler({ path: 'src/index.ts' });

    expect(mockGetWithProject).toHaveBeenCalledTimes(2);
    expect(mockGetWorkspaceForTask).toHaveBeenCalledTimes(2);
  });
});

describe('highlight', () => {
  it('normalizes ranges (end defaults to start) and defaults to yellow', async () => {
    const { highlight } = getTools();
    const result = await highlight!.handler({
      path: 'src/index.ts',
      ranges: [{ start: 2 }, { start: 1, end: 3 }],
    });

    expect(mockSendAtlasEvent).toHaveBeenCalledWith(42, {
      type: 'atlas-highlight',
      path: 'src/index.ts',
      content: 'a\nb\nc',
      ranges: [
        { start: 2, end: 2 },
        { start: 1, end: 3 },
      ],
      color: 'yellow',
    });
    expect(result.content[0]!.text).toBe('Highlighted lines 2, 1-3 in src/index.ts');
  });

  it('rejects inverted ranges', async () => {
    const { highlight } = getTools();
    const result = await highlight!.handler({
      path: 'src/index.ts',
      ranges: [{ start: 3, end: 1 }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Invalid range 3-1: end is before start');
    expect(mockSendAtlasEvent).not.toHaveBeenCalled();
  });

  it('returns a polite no-op when no Explore view is open', async () => {
    mockGetAtlasSubscriberCount.mockReturnValue(0);
    const { highlight } = getTools();
    const result = await highlight!.handler({
      path: 'src/index.ts',
      ranges: [{ start: 1 }],
    });

    expect(result.content[0]!.text).toContain('No Explore view is open');
    expect(mockSendAtlasEvent).not.toHaveBeenCalled();
  });
});

describe('render_artifact', () => {
  const ARTIFACT = {
    html: '<!doctype html><html><body>Flow</body></html>',
    kind: 'flowchart' as const,
    title: 'Demo',
  };

  it('rejects non-HTML input before touching the UI or persistence', async () => {
    const { render_artifact } = getTools();
    const result = await render_artifact!.handler({
      html: 'just some text, not a document',
      kind: 'flowchart',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('complete HTML document');
    expect(mockSendAtlasEvent).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('rejects oversized documents', async () => {
    const { render_artifact } = getTools();
    const huge = '<!doctype html>' + 'x'.repeat(512 * 1024 + 1);
    const result = await render_artifact!.handler({ html: huge, kind: 'plan' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('too large');
    expect(mockSendAtlasEvent).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('renders, persists on ack, and reports success', async () => {
    mockSendAtlasEvent.mockResolvedValue(JSON.stringify({ ok: true }));
    const { render_artifact } = getTools();
    const result = await render_artifact!.handler(ARTIFACT);

    expect(mockSendAtlasEvent).toHaveBeenCalledWith(
      42,
      {
        type: 'atlas-render-artifact',
        kind: 'flowchart',
        title: 'Demo',
        html: ARTIFACT.html,
      },
      15000,
    );
    expect(mockUpsert).toHaveBeenCalledWith(42, {
      kind: 'flowchart',
      title: 'Demo',
      html: ARTIFACT.html,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('Rendered flowchart artifact "Demo"');
  });

  it('does not persist when the view rejects the render', async () => {
    mockSendAtlasEvent.mockRejectedValue(new Error('UI did not acknowledge'));
    const { render_artifact } = getTools();
    const result = await render_artifact!.handler(ARTIFACT);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('UI did not acknowledge');
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('persists and explains when no Explore view is open', async () => {
    mockGetAtlasSubscriberCount.mockReturnValue(0);
    const { render_artifact } = getTools();
    const result = await render_artifact!.handler(ARTIFACT);

    expect(mockSendAtlasEvent).not.toHaveBeenCalled();
    expect(mockUpsert).toHaveBeenCalledWith(42, {
      kind: 'flowchart',
      title: 'Demo',
      html: ARTIFACT.html,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('flowchart artifact saved for this task');
  });

  it('handles an omitted title (null persisted)', async () => {
    mockSendAtlasEvent.mockResolvedValue(JSON.stringify({ ok: true }));
    const { render_artifact } = getTools();
    const result = await render_artifact!.handler({ html: ARTIFACT.html, kind: 'architecture' });

    expect(mockSendAtlasEvent).toHaveBeenCalledWith(
      42,
      { type: 'atlas-render-artifact', kind: 'architecture', html: ARTIFACT.html },
      15000,
    );
    expect(mockUpsert).toHaveBeenCalledWith(42, {
      kind: 'architecture',
      title: null,
      html: ARTIFACT.html,
    });
    expect(result.content[0]!.text).toContain('Rendered architecture artifact "architecture"');
  });

  it('fails cleanly when the task no longer exists', async () => {
    // The pointing tools resolve the workspace eagerly; render_artifact validates
    // shape first, so a non-existent task surfaces only once it broadcasts —
    // which it does not when no view is open. Use an open view to exercise the
    // broadcast path.
    mockSendAtlasEvent.mockRejectedValue(new Error('Task 42 no longer exists'));
    const { render_artifact } = getTools();
    const result = await render_artifact!.handler(ARTIFACT);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Task 42 no longer exists');
  });
});
