import { describe, it, expect } from 'vitest';
import {
  normalizeOperatorMcpServers,
  toCodexMcpServers,
  toOpenCodeMcpConfig,
} from './operatorMcpServers.js';

// The real `~/.claude.json` shape on a real host: a stdio Playwright, an http
// context7 with headers, and an http server with none.
const CLAUDE_JSON_MCP = {
  context7: {
    type: 'http',
    url: 'https://mcp.context7.com/mcp',
    headers: { CONTEXT7_API_KEY: 'ctx7sk-test' },
  },
  playwright: {
    type: 'stdio',
    command: 'npx',
    args: ['@playwright/mcp@latest'],
    env: {},
  },
  'code-atlas': { type: 'http', url: 'http://127.0.0.1:48123/mcp' },
};

describe('normalizeOperatorMcpServers', () => {
  it('normalizes the stdio and http entries of ~/.claude.json', () => {
    expect(normalizeOperatorMcpServers(CLAUDE_JSON_MCP)).toEqual([
      {
        name: 'context7',
        transport: 'http',
        url: 'https://mcp.context7.com/mcp',
        headers: { CONTEXT7_API_KEY: 'ctx7sk-test' },
      },
      {
        name: 'playwright',
        transport: 'stdio',
        command: 'npx',
        args: ['@playwright/mcp@latest'],
        env: {},
      },
      { name: 'code-atlas', transport: 'http', url: 'http://127.0.0.1:48123/mcp', headers: {} },
    ]);
  });

  it('infers the transport from command/url when `type` is absent', () => {
    const servers = normalizeOperatorMcpServers({
      local: { command: 'my-server', args: ['--flag'] },
      remote: { url: 'https://example.test/mcp' },
    });
    expect(servers.map((s) => [s.name, s.transport])).toEqual([
      ['local', 'stdio'],
      ['remote', 'http'],
    ]);
  });

  it('drops entries with neither a command nor a url', () => {
    expect(
      normalizeOperatorMcpServers({
        inProcess: { type: 'sdk' },
        blank: { command: '   ' },
        notAnObject: 'nope',
      }),
    ).toEqual([]);
  });

  it('returns an empty list for a missing config', () => {
    expect(normalizeOperatorMcpServers(null)).toEqual([]);
    expect(normalizeOperatorMcpServers(undefined)).toEqual([]);
  });
});

describe('toCodexMcpServers', () => {
  it('emits the shape `codex mcp add` writes into config.toml', () => {
    const servers = normalizeOperatorMcpServers(CLAUDE_JSON_MCP);
    expect(toCodexMcpServers(servers)).toEqual({
      context7: {
        url: 'https://mcp.context7.com/mcp',
        http_headers: { CONTEXT7_API_KEY: 'ctx7sk-test' },
      },
      playwright: { command: 'npx', args: ['@playwright/mcp@latest'] },
      'code-atlas': { url: 'http://127.0.0.1:48123/mcp' },
    });
  });

  it('keeps a stdio env when the operator set one', () => {
    const servers = normalizeOperatorMcpServers({
      tool: { command: 'run-it', env: { TOKEN: 'abc' } },
    });
    expect(toCodexMcpServers(servers)).toEqual({
      tool: { command: 'run-it', env: { TOKEN: 'abc' } },
    });
  });
});

describe('toOpenCodeMcpConfig', () => {
  it('maps stdio onto McpLocalConfig (command + args in one array)', () => {
    const [server] = normalizeOperatorMcpServers({
      playwright: { command: 'npx', args: ['@playwright/mcp@latest'], env: { CI: '1' } },
    });
    expect(toOpenCodeMcpConfig(server!)).toEqual({
      type: 'local',
      command: ['npx', '@playwright/mcp@latest'],
      environment: { CI: '1' },
      enabled: true,
    });
  });

  it('maps http onto McpRemoteConfig with OAuth discovery off', () => {
    const [server] = normalizeOperatorMcpServers({
      context7: { url: 'https://mcp.context7.com/mcp', headers: { KEY: 'v' } },
    });
    expect(toOpenCodeMcpConfig(server!)).toEqual({
      type: 'remote',
      url: 'https://mcp.context7.com/mcp',
      headers: { KEY: 'v' },
      enabled: true,
      oauth: false,
    });
  });
});
