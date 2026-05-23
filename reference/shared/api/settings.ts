// Request/response shapes for the global-settings endpoints:
//  - /api/settings/prompts*   (per-prompt overrides)
//  - /api/app-settings        (global key/value config)
//  - /api/commands/list       (slash command discovery — orthogonal but
//                              naturally lives here under "settings/admin"
//                              rather than projects.ts since the route
//                              isn't project-scoped)

import { expectType } from './_common';

// ---- Prompts -------------------------------------------------------------

export type PromptKind = 'task' | 'agent' | 'system' | string;

export interface PromptListItem {
  name: string;
  label: string;
  kind: PromptKind;
  isCustomized: boolean;
}

export type ListPromptsResponse = PromptListItem[];

export interface GetPromptResponse {
  name: string;
  label: string;
  kind: PromptKind;
  content: string;
  defaultContent: string;
  variables: string[];
  isCustomized: boolean;
  // mtime is null when the prompt is not customized.
  mtime: number | null;
}

export interface SavePromptRequest {
  content: string;
  // Optional optimistic-concurrency guard. When omitted, the save
  // overwrites unconditionally.
  expectedMtime?: number | undefined;
}

export interface SavePromptResponse {
  name: string;
  mtime: number;
  isCustomized: true;
}

// 400 body when the override references {{vars}} the prompt doesn't define.
export interface UnknownVariablesError {
  error: 'Unknown template variables';
  unknownVariables: string[];
  allowedVariables: string[];
}

// 409 body for concurrent edits.
export interface PromptConcurrentEditError {
  error: 'Prompt was modified by another tab. Reload before saving.';
  currentMtime: number;
}

// `DELETE /api/settings/prompts/:name` — 204 No Content (no body).

// ---- App settings (global key/value) -------------------------------------
//
// Keys are constrained to the allow-list defined in `appSettings.js`
// (`internal_tool_name`, `github_pr_trigger`). The response merges any
// stored values with `APP_SETTINGS_DEFAULTS`, so consumers always see a
// fully-populated shape. Per-agent provider/model/effort is NOT here — it
// moved to per-user storage (`/api/user-agent-model-settings`).

export interface AppSettings {
  internal_tool_name: string;
  github_pr_trigger: string;
}

export type GetAppSettingsResponse = AppSettings;

// PUT accepts a partial subset; the response echoes the full merged set.
export type UpdateAppSettingsRequest = Partial<AppSettings>;

export type UpdateAppSettingsResponse = AppSettings;

// ---- Commands ------------------------------------------------------------

export interface SlashCommandFrontmatter {
  description?: string;
  [key: string]: unknown;
}

export interface SlashCommand {
  name: string;
  path: string;
  relativePath: string;
  description: string;
  namespace: 'project' | 'user';
  metadata: SlashCommandFrontmatter;
}

export interface ListCommandsRequest {
  // Absolute path to the project so we can scan `<path>/.claude/commands/`.
  // When omitted, only the user-scoped `~/.claude/commands/` is scanned.
  projectPath?: string;
}

export interface ListCommandsResponse {
  builtIn: SlashCommand[];
  custom: SlashCommand[];
  count: number;
}

// ---- Type-level smoke checks ---------------------------------------------

expectType<keyof AppSettings>('internal_tool_name');
expectType<keyof AppSettings>('github_pr_trigger');
