// Verify that .env contains every key declared in .env.example. Run via the
// `predev` / `preserver` npm scripts so the dev server fails loudly on first
// start after pulling a branch that introduced a new env var.
//
// Pass: silent (or single confirmation line in verbose mode).
// Fail: list missing keys and exit non-zero.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const examplePath = path.join(root, '.env.example');
const envPath = path.join(root, '.env');

function parseKeys(content: string): Set<string> {
    const keys = new Set<string>();
    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        if (key) keys.add(key);
    }
    return keys;
}

if (!fs.existsSync(examplePath)) {
    process.exit(0);
}

if (!fs.existsSync(envPath)) {
    console.error('\n[check-env] .env is missing.');
    console.error('Copy from the schema and fill in the values:');
    console.error('  cp .env.example .env\n');
    process.exit(1);
}

const expected = parseKeys(fs.readFileSync(examplePath, 'utf8'));
const actual = parseKeys(fs.readFileSync(envPath, 'utf8'));
const missing = [...expected].filter(k => !actual.has(k));

if (missing.length > 0) {
    console.error('\n[check-env] .env is missing keys declared in .env.example:');
    for (const k of missing) console.error(`  - ${k}`);
    console.error(
        '\nA recent commit added these to .env.example. Add them to .env\n' +
        '(use the placeholder values from .env.example as a starting point).\n'
    );
    process.exit(1);
}
