import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { definePortableTool } from './portableTool.js';
import { startPortableMcpGateway, type PortableMcpGateway } from './mcpGateway.js';

describe('portable MCP gateway', () => {
  let gateway: PortableMcpGateway | null = null;

  afterEach(async () => {
    await gateway?.close();
  });

  it('authenticates, advertises and executes a provider-neutral tool over HTTP', async () => {
    gateway = await startPortableMcpGateway(12, [
      definePortableTool(
        'echo_value',
        'Echo a value.',
        { value: z.string() },
        async ({ value }) => ({ content: [{ type: 'text', text: `echo:${value}` }] }),
      ),
    ]);
    expect(gateway).not.toBeNull();

    const unauthorized = await fetch(gateway!.url, { method: 'POST', body: '{}' });
    expect(unauthorized.status).toBe(401);

    const client = new Client({ name: 'gateway-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(gateway!.url), {
      requestInit: { headers: { Authorization: `Bearer ${gateway!.token}` } },
    });
    await client.connect(transport as never);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['echo_value']);
    const result = await client.callTool({ name: 'echo_value', arguments: { value: 'portable' } });
    expect(result.content).toEqual([{ type: 'text', text: 'echo:portable' }]);
    await client.close();
  });
});
