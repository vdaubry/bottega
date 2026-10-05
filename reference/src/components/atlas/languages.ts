/**
 * Extension → CodeMirror language mapping for the Explore file viewer. Built on
 * the first-party `@codemirror/lang-*` grammars where they exist, and on the
 * stream parsers in `@codemirror/legacy-modes` for everything else (Ruby, YAML,
 * shell, SQL) so a typical Rails / Python / JS repo highlights end to end.
 * Unknown extensions fall back to plain text (no extension).
 */

import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { StreamLanguage } from '@codemirror/language';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { standardSQL } from '@codemirror/legacy-modes/mode/sql';
import type { Extension } from '@uiw/react-codemirror';

interface LanguageEntry {
  name: string;
  load: () => Extension;
}

const jsEntry: LanguageEntry = { name: 'javascript', load: () => javascript() };
const tsEntry: LanguageEntry = { name: 'typescript', load: () => javascript({ typescript: true }) };
const jsonEntry: LanguageEntry = { name: 'json', load: () => json() };
const cssEntry: LanguageEntry = { name: 'css', load: () => css() };
const htmlEntry: LanguageEntry = { name: 'html', load: () => html() };
const markdownEntry: LanguageEntry = { name: 'markdown', load: () => markdown() };
const pythonEntry: LanguageEntry = { name: 'python', load: () => python() };
const rubyEntry: LanguageEntry = { name: 'ruby', load: () => StreamLanguage.define(ruby) };
const yamlEntry: LanguageEntry = { name: 'yaml', load: () => StreamLanguage.define(yaml) };
const shellEntry: LanguageEntry = { name: 'shell', load: () => StreamLanguage.define(shell) };
const sqlEntry: LanguageEntry = { name: 'sql', load: () => StreamLanguage.define(standardSQL) };

const BY_EXTENSION: Record<string, LanguageEntry> = {
  // JavaScript / TypeScript
  js: jsEntry,
  mjs: jsEntry,
  cjs: jsEntry,
  jsx: { name: 'javascript', load: () => javascript({ jsx: true }) },
  ts: tsEntry,
  mts: tsEntry,
  cts: tsEntry,
  tsx: { name: 'typescript', load: () => javascript({ typescript: true, jsx: true }) },
  // Data / config
  json: jsonEntry,
  yml: yamlEntry,
  yaml: yamlEntry,
  // Styles (the CSS grammar covers SCSS/Sass/Less well enough for read-only viewing)
  css: cssEntry,
  scss: cssEntry,
  sass: cssEntry,
  less: cssEntry,
  // Markup
  html: htmlEntry,
  htm: htmlEntry,
  xhtml: htmlEntry,
  vue: htmlEntry,
  // Markdown
  md: markdownEntry,
  markdown: markdownEntry,
  // Python
  py: pythonEntry,
  pyi: pythonEntry,
  pyw: pythonEntry,
  // Ruby (incl. Rails templating DSLs that are plain Ruby: RABL, jbuilder, rake…)
  rb: rubyEntry,
  rake: rubyEntry,
  ru: rubyEntry,
  gemspec: rubyEntry,
  rabl: rubyEntry,
  jbuilder: rubyEntry,
  arb: rubyEntry,
  thor: rubyEntry,
  // Shell
  sh: shellEntry,
  bash: shellEntry,
  zsh: shellEntry,
  // SQL
  sql: sqlEntry,
};

// Extension-less files that are nonetheless Ruby in a Rails/Ruby repo.
const BY_BASENAME: Record<string, LanguageEntry> = {
  Gemfile: rubyEntry,
  Rakefile: rubyEntry,
  Guardfile: rubyEntry,
  Capfile: rubyEntry,
  Vagrantfile: rubyEntry,
  Berksfile: rubyEntry,
  Thorfile: rubyEntry,
  Podfile: rubyEntry,
  Brewfile: rubyEntry,
  Appraisals: rubyEntry,
  Dangerfile: rubyEntry,
  Fastfile: rubyEntry,
  Appfile: rubyEntry,
};

function basenameOf(path: string): string {
  return path.split('/').pop() ?? path;
}

function extensionOf(base: string): string {
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * ERB views carry a compound extension whose *inner* segment names the real
 * output language: `show.html.erb` → HTML, `index.json.erb` → JSON,
 * `widget.js.erb` → JavaScript. Strip the `.erb` and resolve that inner
 * extension, defaulting to HTML (the overwhelmingly common case). We keep the
 * `erb` label so the UI still shows the file is a template.
 */
function resolveErb(base: string): LanguageEntry {
  const inner = extensionOf(base.slice(0, base.length - '.erb'.length));
  const innerEntry = inner ? BY_EXTENSION[inner] : undefined;
  return { name: 'erb', load: (innerEntry ?? htmlEntry).load };
}

function resolveEntry(path: string): LanguageEntry | null {
  const base = basenameOf(path);
  const byName = BY_BASENAME[base];
  if (byName) return byName;
  const ext = extensionOf(base);
  if (ext === 'erb') return resolveErb(base);
  return BY_EXTENSION[ext] ?? null;
}

export function languageFor(path: string): Extension[] {
  const entry = resolveEntry(path);
  return entry ? [entry.load()] : [];
}

export function languageNameFor(path: string): string {
  return resolveEntry(path)?.name ?? 'plain text';
}
