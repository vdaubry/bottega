// The operator's own MCP servers, for every provider.
//
// `loadMcpConfig` (sdkOptions.ts) reads `~/.claude.json` and hands the result
// straight to the Claude SDK, which speaks that shape natively. Codex and
// OpenCode do not: each has its own config vocabulary, and until this module
// existed neither ever saw those servers at all — a Codex or OpenCode turn
// carried only Bottega's own per-turn gateway. That is why a review agent
// running on Codex reported "this session has no Playwright/browser connector"
// and blocked its ticket while every Claude review on the same box drove a
// browser fine.
//
// So: normalize the `~/.claude.json` entries once into a provider-neutral
// descriptor, then translate per provider. Bottega's gateway is added
// separately by each provider and is not this module's business.
//
// It lives in `shared/` — the contract layer — and imports nothing, because the
// provider modules import it and they are reachable from `agentModelSettings`.
// A single edge from here into the conversation runtime would drag
// `sdkOptions` -> `sqliteSessionStore` (which touches `db` at module load) into
// every import graph that so much as names a provider; that is exactly what
// broke `routes/atlas.test.ts` when this file first landed under
// `services/conversation/`. Reading the operator's config is
// `conversation/operatorMcpForTurn.ts`'s job; this file only translates.

/** A `~/.claude.json` MCP entry, normalized. */
export type OperatorMcpServer =
  | {
      name: string;
      transport: 'stdio';
      command: string;
      args: string[];
      env: Record<string, string>;
    }
  | {
      name: string;
      transport: 'http';
      url: string;
      headers: Record<string, string>;
    };

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

/**
 * Normalize the `mcpServers` map from `~/.claude.json`. Entries Bottega cannot
 * express for a non-Claude provider (an SDK-side in-process server, a malformed
 * row) are dropped rather than passed on half-built — a provider that rejects
 * its whole MCP config would lose the Bottega gateway with it.
 */
export function normalizeOperatorMcpServers(
  raw: Record<string, unknown> | null | undefined,
): OperatorMcpServer[] {
  if (!raw) return [];
  const servers: OperatorMcpServer[] = [];

  for (const [name, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;

    // `type` is advisory in `~/.claude.json` (it is often absent): the
    // presence of `command` or `url` is what actually decides the transport.
    if (typeof entry['command'] === 'string' && entry['command'].trim() !== '') {
      servers.push({
        name,
        transport: 'stdio',
        command: entry['command'],
        args: Array.isArray(entry['args'])
          ? entry['args'].filter((arg): arg is string => typeof arg === 'string')
          : [],
        env: asStringRecord(entry['env']),
      });
      continue;
    }

    if (typeof entry['url'] === 'string' && entry['url'].trim() !== '') {
      servers.push({
        name,
        transport: 'http',
        url: entry['url'],
        headers: asStringRecord(entry['headers']),
      });
    }
  }

  return servers;
}

/**
 * A value the Codex CLI's `--config` flattener accepts — structurally the
 * SDK's own recursive `CodexConfigValue`, restated here so this module does
 * not import a provider SDK.
 */
export type CodexConfigValue =
  | string
  | number
  | boolean
  | CodexConfigValue[]
  | { [key: string]: CodexConfigValue };

/**
 * Codex `mcp_servers` config, ready to merge under `CodexOptions.config`. The
 * SDK flattens this into `--config mcp_servers.<name>.<key>=<toml>` overrides;
 * the shape below is exactly what `codex mcp add` writes into `config.toml`
 * (verified against the CLI bundled with `@openai/codex-sdk`).
 */
export function toCodexMcpServers(
  servers: OperatorMcpServer[],
): Record<string, { [key: string]: CodexConfigValue }> {
  const out: Record<string, { [key: string]: CodexConfigValue }> = {};

  for (const server of servers) {
    if (server.transport === 'stdio') {
      out[server.name] = {
        command: server.command,
        ...(server.args.length > 0 ? { args: server.args } : {}),
        ...(Object.keys(server.env).length > 0 ? { env: server.env } : {}),
      };
    } else {
      out[server.name] = {
        url: server.url,
        ...(Object.keys(server.headers).length > 0 ? { http_headers: server.headers } : {}),
      };
    }
  }

  return out;
}

/** One OpenCode `McpLocalConfig` / `McpRemoteConfig`, for `client.mcp.add`. */
export function toOpenCodeMcpConfig(
  server: OperatorMcpServer,
):
  | { type: 'local'; command: string[]; environment?: Record<string, string>; enabled: true }
  | { type: 'remote'; url: string; headers?: Record<string, string>; enabled: true; oauth: false } {
  if (server.transport === 'stdio') {
    return {
      type: 'local',
      command: [server.command, ...server.args],
      ...(Object.keys(server.env).length > 0 ? { environment: server.env } : {}),
      enabled: true,
    };
  }
  return {
    type: 'remote',
    url: server.url,
    ...(Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}),
    enabled: true,
    // Bottega passes whatever headers the operator configured; letting the
    // OpenCode client attempt its own OAuth discovery on top would open an
    // interactive flow no agent turn can complete.
    oauth: false,
  };
}

