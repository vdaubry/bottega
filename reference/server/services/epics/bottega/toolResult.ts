// Result helpers for the in-process `bottega` MCP tools.
//
// Ported from the atlas server's private helpers (atlas/mcpServer.ts) and
// shared here because the bottega catalog grows across phases: the
// specification agent gets one tool, the stories agent four more (Phase 5) and
// the orchestrator a dozen (Phase 7).
//
// A guard violation is NOT an exception: it is a `fail()` result the model
// reads and reacts to (retry with different arguments, or tell the user). Tool
// handlers must therefore never throw — an escaped exception surfaces to the
// SDK as an opaque transport error the model cannot act on.

// Structurally compatible with the MCP SDK's CallToolResult (which is not
// directly importable here — @modelcontextprotocol/sdk is the agent SDK's own
// dependency, not hoisted into ours).
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/** Structured payload for tools that return data rather than a confirmation. */
export function okJson(value: unknown): ToolResult {
  return ok(JSON.stringify(value, null, 2));
}

/**
 * A refusal the model is expected to read. Phrase it as
 * "<what went wrong>. <what to do instead>" — the model's next action is only
 * as good as this sentence.
 */
export function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
