import { z, type ZodRawShape } from 'zod';

export interface PortableToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Provider-neutral tool definition. Owner domains describe a tool once and
 * the conversation runtime adapts it to Claude's in-process SDK server or the
 * shared Streamable HTTP MCP gateway used by Codex and OpenCode.
 */
export interface PortableTool {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  handler: (input: Record<string, unknown>) => Promise<PortableToolResult>;
}

export function definePortableTool<Shape extends ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Shape,
  handler: (input: z.infer<z.ZodObject<Shape>>) => Promise<PortableToolResult>,
): PortableTool {
  const schema = z.object(inputSchema);
  return {
    name,
    description,
    inputSchema,
    handler: async (input) => handler(schema.parse(input)),
  };
}
