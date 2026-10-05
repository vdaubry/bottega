import http from 'http';
import { randomBytes } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { PortableTool } from './portableTool.js';

export interface PortableMcpGateway {
  name: string;
  url: string;
  token: string;
  toolNames: string[];
  close(): Promise<void>;
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 2_000_000) throw new Error('MCP request exceeds 2 MB');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Start a loopback-only, bearer-authenticated stateless MCP endpoint for one
 * provider turn. A fresh protocol server is used per request, while every
 * handler closes over the conversation's authenticated owner context.
 */
export async function startPortableMcpGateway(
  conversationId: number,
  tools: PortableTool[],
): Promise<PortableMcpGateway | null> {
  if (tools.length === 0) return null;
  const token = randomBytes(32).toString('base64url');
  const name = `bottega-${conversationId}-${randomBytes(4).toString('hex')}`;

  const server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end('Unauthorized');
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end('Method Not Allowed');
      return;
    }

    const protocol = new McpServer({ name, version: '0.1.0' });
    for (const definition of tools) {
      protocol.registerTool(
        definition.name,
        { description: definition.description, inputSchema: definition.inputSchema },
        definition.handler,
      );
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as never);
    try {
      const body = await readJsonBody(request);
      await protocol.connect(transport as never);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    } finally {
      // `handleRequest` resolves after the stateless response is complete. Do
      // not register a late `close` listener here: a fast client may already
      // have closed the response, leaving the per-request protocol alive.
      await protocol.close().catch(() => {});
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Portable MCP gateway did not bind a TCP port');
  }

  return {
    name,
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    toolNames: tools.map((tool) => tool.name),
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
