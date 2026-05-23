#!/usr/bin/env tsx
// Belt-and-braces guard for the TypeScript migration. tsconfig's `allowJs:
// false` already stops new .js files from being type-checked, but it doesn't
// stop them from being committed. This script does — wired into `prelint`
// so CI fails on any new .js/.jsx file outside the allowlist.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  'build',
  'tmp',
]);

// Files that must stay .js because they're served verbatim to the browser
// at a fixed path (Vite's `public/` directory is not transpiled). Service
// workers in particular have to be a real .js URL.
const ALLOWLIST = new Set<string>([
  'public/sw.js',
]);

function walk(dir: string, hits: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, hits);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.js') || entry.name.endsWith('.jsx')) {
      const rel = path.relative(root, full);
      if (!ALLOWLIST.has(rel)) hits.push(rel);
    }
  }
}

const hits: string[] = [];
walk(root, hits);

if (hits.length > 0) {
  console.error('\n[guard-no-js] Found .js/.jsx files outside the allowlist:');
  for (const f of hits) console.error(`  - ${f}`);
  console.error(
    '\nThis repo is TypeScript-only after Phase 6.4. Convert the file to .ts/.tsx,\n' +
    'or — if it must stay JS — add the path to scripts/guard-no-js.ts allowlist.\n'
  );
  process.exit(1);
}
