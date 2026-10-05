/**
 * Figma MCP write surface — denied for every agent, everywhere.
 *
 * The Figma plugin is enabled in the operator's `~/.claude/settings.json`;
 * `mapOptionsToSDK` sets `settingSources: ['project','user','local']` so a
 * fresh turn picks it up, and `conversation/pluginConfig.ts` names it
 * explicitly so a resumed turn keeps it (the SDK resumes a store-backed
 * session in a temporary config dir with no plugins). Either way every Figma
 * tool reaches every Claude turn. The read tools are the point — planning and
 * implementing against real designs. These mutate Figma state, and no Bottega
 * agent may ever call them:
 * unlike a repo there is no `git checkout` to undo a bad node edit, and the
 * designs belong to people outside this system.
 *
 * `weave_run_tool` is denied for a second reason: per its own schema it
 * "spends the user's Weave credits" and expects an explicit Approve/Cancel
 * from a human. Every Bottega turn runs under `bypassPermissions`, so there is
 * nobody to ask.
 *
 * Enforced centrally in `conversation/sdkOptions.ts` (every SDK turn) and in
 * `titleGenerator.ts` (the one path that spawns the `claude` CLI directly).
 *
 * Fail-open caveat: this is a denylist, so a Figma tool added after this list
 * was written is allowed by default. Re-audit against the server's tool list
 * when bumping the plugin — `weave_*` arrived that way.
 */
export const FIGMA_WRITE_TOOLS = [
  'mcp__plugin_figma_figma__use_figma',
  'mcp__plugin_figma_figma__generate_figma_design',
  'mcp__plugin_figma_figma__create_new_file',
  'mcp__plugin_figma_figma__generate_diagram',
  'mcp__plugin_figma_figma__upload_assets',
  'mcp__plugin_figma_figma__add_code_connect_map',
  'mcp__plugin_figma_figma__send_code_connect_mappings',
  'mcp__plugin_figma_figma__weave_run_tool',
  'mcp__plugin_figma_figma__weave_upload_asset',
  'mcp__plugin_figma_figma__weave_cancel_tool_run',
] as const;
