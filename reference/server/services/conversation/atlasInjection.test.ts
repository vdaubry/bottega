import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetById, mockBuildAtlasMcpServer } = vi.hoisted(() => ({
  mockGetById: vi.fn(),
  mockBuildAtlasMcpServer: vi.fn(),
}));

vi.mock('../../database/conversations.js', () => ({
  conversationsDb: { getById: mockGetById },
}));

vi.mock('../atlas/mcpServer.js', () => ({
  buildAtlasMcpServer: mockBuildAtlasMcpServer,
}));

import { withAtlasMcpServer } from './atlasInjection.js';

const ARGS = { conversationId: 99, taskId: 7, userId: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  mockBuildAtlasMcpServer.mockReturnValue({ type: 'sdk', name: 'code-atlas' });
});

describe('withAtlasMcpServer', () => {
  it('injects the code-atlas server for atlas-enabled conversations', () => {
    mockGetById.mockReturnValue({ id: 99, atlas_enabled: 1 });

    const result = withAtlasMcpServer({ playwright: { command: 'npx' } }, ARGS);

    expect(mockBuildAtlasMcpServer).toHaveBeenCalledWith({ taskId: 7, userId: 1 });
    expect(result).toEqual({
      playwright: { command: 'npx' },
      'code-atlas': { type: 'sdk', name: 'code-atlas' },
    });
  });

  it('injects even when no other MCP servers are configured', () => {
    mockGetById.mockReturnValue({ id: 99, atlas_enabled: 1 });

    const result = withAtlasMcpServer(null, ARGS);

    expect(result).toEqual({ 'code-atlas': { type: 'sdk', name: 'code-atlas' } });
  });

  it('passes plain conversations through untouched (row flag is the source of truth)', () => {
    mockGetById.mockReturnValue({ id: 99, atlas_enabled: 0 });

    const existing = { playwright: { command: 'npx' } };
    expect(withAtlasMcpServer(existing, ARGS)).toBe(existing);
    expect(withAtlasMcpServer(null, ARGS)).toBeNull();
    expect(mockBuildAtlasMcpServer).not.toHaveBeenCalled();
  });

  it('treats a missing conversation row as not atlas-enabled', () => {
    mockGetById.mockReturnValue(undefined);

    expect(withAtlasMcpServer(null, ARGS)).toBeNull();
    expect(mockBuildAtlasMcpServer).not.toHaveBeenCalled();
  });
});
