/**
 * Operator plugins → every SDK turn, resumed turns included.
 *
 * A plugin enabled in the operator's `~/.claude/settings.json` (the Figma MCP
 * plugin today) reaches a FRESH Claude turn on its own: the CLI reads
 * `enabledPlugins` from the user settings and resolves each plugin's install
 * path from `~/.claude/plugins/installed_plugins.json`. A RESUMED turn does
 * not get it. With `resume` + `sessionStore` (every `sendMessage`), the SDK
 * loads the transcript from SQLite into a temporary config dir
 * (`/tmp/claude-resume-<uuid>/` — the transcript, `.claude.json` and a copy
 * of `.credentials.json`) and spawns the CLI with `CLAUDE_CONFIG_DIR` pointing
 * there. That dir has no `plugins/`, so `enabledPlugins` resolves to nothing
 * and every plugin MCP server silently vanishes after a conversation's first
 * turn. Verified on SDK 0.3.220 and 0.3.240 (the latter copies `settings.json`
 * into the temp dir too, but still no plugins) — the transcript fingerprint is
 * a `deferred_tools_delta` removing every `mcp__plugin_figma_*` tool on the
 * first resumed turn.
 *
 * So Bottega names the plugins explicitly through the SDK's `plugins` option,
 * read from the same two files the CLI would have read. On a fresh turn the
 * CLI dedupes the explicit entry against the settings-enabled one (one
 * `plugin:figma:figma` server, not two); on a resumed turn it is the only
 * reason the plugin loads. The plugin's OAuth state still comes from the
 * copied `.credentials.json`, keyed by server config, so it matches.
 *
 * Same shape as `loadMcpConfig` (`sdkOptions.ts`): derived from the operator's
 * files on every call, never cached (a plugin update swaps the install path),
 * and fail-open to "no plugins" on anything malformed — a broken plugin file
 * must not take conversations down.
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

/** The SDK's `plugins` entry shape (`SdkPluginConfig`, local plugins only). */
export interface SdkLocalPlugin {
  type: 'local';
  path: string;
}

interface InstalledPluginEntry {
  scope?: unknown;
  installPath?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The config dir the CLI reads on a fresh turn — `CLAUDE_CONFIG_DIR` when the
 * operator sets one, `~/.claude` otherwise. Bottega never sets it itself (the
 * per-user dirs under `~/.config/bottega/users/` only hold the OAuth token).
 */
export function resolveOperatorClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

async function readJsonIfPresent(file: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(raw) as unknown;
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `installed_plugins.json` v2 keeps an array of install records per plugin
 * (one per scope); older files kept a single object. Accept both.
 */
function installRecords(value: unknown): InstalledPluginEntry[] {
  if (Array.isArray(value)) return value.filter(isObject);
  if (isObject(value)) return [value];
  return [];
}

/**
 * The plugins enabled in the operator's user settings, as SDK `plugins`
 * entries. Ordered by plugin name so the CLI args are deterministic.
 */
export async function loadEnabledPlugins(
  configDir: string = resolveOperatorClaudeConfigDir(),
): Promise<SdkLocalPlugin[]> {
  try {
    const settings = await readJsonIfPresent(path.join(configDir, 'settings.json'));
    const enabled =
      isObject(settings) && isObject(settings.enabledPlugins) ? settings.enabledPlugins : null;
    if (!enabled) return [];
    const enabledNames = Object.entries(enabled)
      .filter(([, on]) => on === true)
      .map(([name]) => name)
      .sort();
    if (enabledNames.length === 0) return [];

    const installed = await readJsonIfPresent(
      path.join(configDir, 'plugins', 'installed_plugins.json'),
    );
    const registry =
      isObject(installed) && isObject(installed.plugins) ? installed.plugins : null;
    if (!registry) return [];

    const plugins: SdkLocalPlugin[] = [];
    for (const name of enabledNames) {
      const records = installRecords(registry[name]);
      const record = records.find((r) => r.scope === 'user') ?? records[0];
      const installPath = record?.installPath;
      if (typeof installPath !== 'string' || !path.isAbsolute(installPath)) continue;
      if (!(await isDirectory(installPath))) continue;
      plugins.push({ type: 'local', path: installPath });
    }
    return plugins;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ConversationAdapter] Error loading operator plugins:', message);
    return [];
  }
}
