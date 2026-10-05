import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULTS_ROOT = path.join(__dirname, '..', 'constants');

function getArchiveRoot(): string {
  return process.env.BOTTEGA_ARCHIVE_ROOT || path.join(os.homedir(), '.bottega');
}

type PromptKind = 'prompt' | 'template';

const KIND_DIR: Record<PromptKind, string> = {
  prompt: 'prompts',
  template: 'templates',
};

function dirNameForKind(kind: PromptKind): string {
  const dir = KIND_DIR[kind];
  if (!dir) throw new Error(`Unknown prompt kind: ${kind}`);
  return dir;
}

function getDefaultsDir(kind: PromptKind): string {
  return path.join(DEFAULTS_ROOT, dirNameForKind(kind));
}

function getOverridesDir(kind: PromptKind): string {
  return path.join(getArchiveRoot(), dirNameForKind(kind));
}

export function getPromptsDir(): string {
  return getOverridesDir('prompt');
}

export function getTemplatesDir(): string {
  return getOverridesDir('template');
}

export interface PromptDefinition {
  name: string;
  label: string;
  kind: PromptKind;
  file: string;
  variables: string[];
  /** Operator-facing explanation shown under the label in the editor. */
  description?: string;
}

const PROMPT_DEFINITIONS: PromptDefinition[] = [
  {
    name: 'planification',
    label: 'Planification',
    kind: 'prompt',
    file: 'planification.md',
    // planTemplatePath is legacy (pre-inlining overrides may still use it)
    variables: ['taskDocPath', 'taskId', 'planTemplate', 'planTemplatePath'],
  },
  {
    name: 'planification-nontechnical',
    label: 'Planification (non-technical)',
    kind: 'prompt',
    file: 'planification-nontechnical.md',
    // planTemplatePath is legacy (pre-inlining overrides may still use it).
    // sensitiveAreasSection is the project's sensitive-areas guardrail,
    // pre-rendered by generatePlanificationMessage (empty when the list is).
    variables: ['taskDocPath', 'taskId', 'planTemplate', 'planTemplatePath', 'sensitiveAreasSection'],
  },
  {
    name: 'implementation',
    label: 'Implementation',
    kind: 'prompt',
    file: 'implementation.md',
    variables: ['taskDocPath', 'taskId'],
  },
  {
    name: 'review',
    label: 'Review',
    kind: 'prompt',
    file: 'review.md',
    variables: ['taskDocPath', 'taskId'],
  },
  {
    name: 'refinement',
    label: 'Refinement',
    kind: 'prompt',
    file: 'refinement.md',
    variables: ['taskDocPath', 'taskId', 'baseBranch'],
  },
  {
    name: 'pr',
    label: 'PR Agent',
    kind: 'prompt',
    file: 'pr.md',
    // prCreateOrVerifyBlock is legacy — the same text as prPublishBlock, kept so
    // overrides written before the block stopped branching on "a PR exists"
    // still render. Use prPublishBlock in new text.
    variables: [
      'taskDocPath',
      'taskId',
      'prContextLine',
      'prPublishBlock',
      'prCreateOrVerifyBlock',
      'baseBranch',
    ],
  },
  {
    name: 'yolo',
    label: 'YOLO Agent',
    kind: 'prompt',
    file: 'yolo.md',
    // prCreateOrVerifyBlock is legacy — see the 'pr' definition above.
    variables: [
      'taskDocPath',
      'taskId',
      'prContextLine',
      'prPublishBlock',
      'prCreateOrVerifyBlock',
      'baseBranch',
    ],
  },
  {
    name: 'pr-feedback',
    label: 'PR Feedback Response',
    kind: 'prompt',
    file: 'pr-feedback.md',
    variables: ['taskDocPath', 'taskId', 'prUrl', 'feedbackSection', 'baseBranch'],
  },
  {
    name: 'plan-template',
    label: 'Plan Template',
    kind: 'template',
    file: 'plan-template.md',
    variables: [],
  },
  {
    name: 'planification-sensitive-areas',
    label: 'Planification: sensitive-areas protocol',
    kind: 'prompt',
    file: 'planification-sensitive-areas.md',
    variables: ['sensitiveAreas', 'taskId'],
    description:
      "The escalation protocol wrapped around a project's \"Sensitive areas\" list (Edit project) and injected into the non-technical planification prompt — only when that list is non-empty.",
  },
  {
    name: 'atlas-artifact',
    label: 'Explore Artifact Generation',
    kind: 'prompt',
    file: 'atlas-artifact.md',
    variables: ['taskDocPath', 'taskId', 'kind', 'styleRefsDir'],
  },
  {
    name: 'epic-architecture',
    label: 'Epic: Architecture',
    kind: 'prompt',
    file: 'epic-architecture.md',
    variables: [
      'epicId',
      'epicName',
      'specDir',
      'specFileList',
      'architectureDir',
      'architectureFileList',
      'repoPath',
    ],
  },
  {
    name: 'epic-specification',
    label: 'Epic: Specification',
    kind: 'prompt',
    file: 'epic-specification.md',
    variables: [
      'epicId',
      'epicName',
      'specDir',
      'specFileList',
      'docsDir',
      'docsFileList',
      'architectureDir',
      'architectureFileList',
      'repoPath',
    ],
  },
  {
    name: 'epic-stories',
    label: 'Epic: Stories',
    kind: 'prompt',
    file: 'epic-stories.md',
    variables: ['epicId', 'epicName', 'specDir', 'docsDir', 'docsFileList', 'repoPath'],
  },
  {
    name: 'epic-spec-review',
    label: 'Epic: Specification review',
    kind: 'prompt',
    file: 'epic-spec-review.md',
    variables: [
      'epicId',
      'epicName',
      'specDir',
      'specFileList',
      'architectureDir',
      'architectureFileList',
      'docsDir',
      'docsFileList',
      'ticketTable',
      'reviewDir',
      'reviewFileList',
      'repoPath',
    ],
  },
  {
    name: 'epic-orchestrator',
    label: 'Epic: Orchestrator',
    kind: 'prompt',
    file: 'epic-orchestrator.md',
    variables: [
      'epicId',
      'epicName',
      'ticketTaskId',
      'ticketTitle',
      'ticketPosition',
      'ticketCount',
      'ticketDoc',
      'masterDoc',
      'docsDir',
      'storyTable',
      'outcomeNotes',
      'repoPath',
    ],
  },
  {
    name: 'epic-pr-review',
    label: 'Epic: PR reviewer',
    kind: 'prompt',
    file: 'epic-pr-review.md',
    variables: [
      'epicId',
      'epicName',
      'ticketTaskId',
      'ticketTitle',
      'ticketPosition',
      'ticketCount',
      'ticketDoc',
      'taskDocPath',
      'masterDoc',
      'docsDir',
      'storyTable',
      'outcomeNotes',
      'worktreePath',
      'prUrl',
      'baseBranch',
    ],
  },
  {
    name: 'epic-delivery',
    label: 'Epic: Delivery',
    kind: 'prompt',
    file: 'epic-delivery.md',
    variables: [
      'epicId',
      'epicName',
      'openingSection',
      'worktreePath',
      'featureBranch',
      'defaultBranch',
      'prSection',
      'repoPath',
      'ticketTable',
    ],
  },
  {
    name: 'epic-qa-scenarios',
    label: 'Epic: QA scenarios',
    kind: 'prompt',
    file: 'epic-qa-scenarios.md',
    variables: [
      'epicId',
      'epicName',
      'specDir',
      'specFileList',
      'architectureDir',
      'architectureFileList',
      'docsDir',
      'docsFileList',
      'ticketTable',
      'qaDir',
      'qaCsvPath',
      'qaCsvState',
      'repoPath',
    ],
  },
  {
    name: 'epic-qa-execution',
    label: 'Epic: QA execution',
    kind: 'prompt',
    file: 'epic-qa-execution.md',
    variables: [
      'epicId',
      'epicName',
      'worktreePath',
      'featureBranch',
      'devServerPort',
      'qaCsvPath',
      'qaProgress',
      'docsDir',
      'docsFileList',
      'repoPath',
    ],
  },
  {
    name: 'epic-qa-fix',
    label: 'Epic: QA fix',
    kind: 'prompt',
    file: 'epic-qa-fix.md',
    variables: [
      'epicId',
      'epicName',
      'repoPath',
      'deliveryWorktreePath',
      'featureBranch',
      'devServerPort',
      'qaCsvPath',
      'failCount',
      'failedScenarios',
      'masterDoc',
      'docsDir',
      'docsFileList',
      'storyTable',
    ],
  },
];

/**
 * Absolute path to the vendored effective-html style-reference corpus the
 * `atlas-artifact` prompt points the agent at. Resolved from this module's
 * location so it works in any checkout (dev, worktree, deploy).
 */
export function getAtlasStyleRefsDir(): string {
  return path.join(DEFAULTS_ROOT, 'atlas-style-refs');
}

/**
 * Absolute path to the completion scripts (`complete-plan.ts`, `complete-pr.ts`,
 * …) the prompts tell agents to run. An agent runs them by absolute path from
 * its own task worktree, so the path is resolved from this module's location —
 * it works wherever Bottega is installed.
 */
export function getScriptsDir(): string {
  return path.resolve(__dirname, '..', '..', 'scripts');
}

/** Variables every prompt may use without listing them in its definition. */
const BUILTIN_VARIABLES = ['scriptsDir'];

/** Every variable a prompt's text may reference: its own plus the built-ins. */
export function allowedVariables(def: PromptDefinition): string[] {
  return def.kind === 'template' ? def.variables : [...def.variables, ...BUILTIN_VARIABLES];
}

const PROMPT_BY_NAME = new Map(PROMPT_DEFINITIONS.map((p) => [p.name, p]));

export function listPromptNames(): string[] {
  return PROMPT_DEFINITIONS.map((p) => p.name);
}

export function getPromptDefinition(name: string): PromptDefinition | null {
  return PROMPT_BY_NAME.get(name) || null;
}

function requireDef(name: string): PromptDefinition {
  const def = getPromptDefinition(name);
  if (!def) throw new Error(`Unknown prompt: ${name}`);
  return def;
}

function defaultPath(name: string): string {
  const def = requireDef(name);
  return path.join(getDefaultsDir(def.kind), def.file);
}

function overridePath(name: string): string {
  const def = requireDef(name);
  return path.join(getOverridesDir(def.kind), def.file);
}

export function loadDefault(name: string): string {
  const p = defaultPath(name);
  if (!fs.existsSync(p)) {
    throw new Error(`Missing default prompt file: ${p}`);
  }
  return fs.readFileSync(p, 'utf8');
}

export function hasOverride(name: string): boolean {
  return fs.existsSync(overridePath(name));
}

export function loadOverride(name: string): string | null {
  const p = overridePath(name);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

export function getOverrideMtime(name: string): number | null {
  const p = overridePath(name);
  if (!fs.existsSync(p)) return null;
  return fs.statSync(p).mtimeMs;
}

export function loadPrompt(name: string): string {
  const override = loadOverride(name);
  if (override !== null) return override;
  return loadDefault(name);
}

/**
 * Return the absolute path to the active version of a prompt or template:
 * the override path if an override exists, otherwise the bundled default path.
 * Only used for the legacy {{planTemplatePath}} variable — never @-reference
 * this path from a prompt: an @-file mention makes the Claude Agent SDK pull
 * Bottega's own CLAUDE.md into the target repo's agent context. Inline the
 * content (loadPrompt) instead.
 */
export function resolvePromptPath(name: string): string {
  return hasOverride(name) ? overridePath(name) : defaultPath(name);
}

export function saveOverride(name: string, content: string): number {
  const def = requireDef(name);
  const dir = getOverridesDir(def.kind);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const p = overridePath(name);
  fs.writeFileSync(p, content, 'utf8');
  return fs.statSync(p).mtimeMs;
}

export function deleteOverride(name: string): boolean {
  const p = overridePath(name);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    return true;
  }
  return false;
}

/**
 * Replace {{var}} placeholders. Throws on missing variable to surface
 * misconfiguration early rather than silently rendering empty strings.
 */
export function render(template: string, callerVars: Record<string, unknown>): string {
  const vars: Record<string, unknown> = { scriptsDir: getScriptsDir(), ...callerVars };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in vars)) {
      throw new Error(`Missing prompt variable: ${key}`);
    }
    const v = vars[key];
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return JSON.stringify(v);
  });
}

/**
 * Return all {{var}} names referenced in the template, deduplicated.
 */
export function extractVariables(template: string): string[] {
  const seen = new Set<string>();
  const re = /\{\{(\w+)\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(template)) !== null) {
    seen.add(match[1]!);
  }
  return [...seen];
}

/**
 * Validate that a candidate template only references variables in the
 * allowlist for the given prompt. Returns an array of unknown names
 * (empty if valid). Templates (kind === 'template') are read as-is by the
 * agent and never go through render(), so {{ … }} markers in them are
 * literal text and validation is skipped.
 */
export function findUnknownVariables(name: string, content: string): string[] {
  const def = requireDef(name);
  if (def.kind === 'template') return [];
  const allowed = new Set(allowedVariables(def));
  const used = extractVariables(content);
  return used.filter((v) => !allowed.has(v));
}

/**
 * Convenience: load a prompt by name and render with vars.
 */
export function renderPrompt(name: string, vars: Record<string, unknown>): string {
  return render(loadPrompt(name), vars);
}
