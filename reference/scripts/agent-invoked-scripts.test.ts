/**
 * The scripts the agent prompts hand to agents must load from ANY cwd.
 *
 * An agent runs them from its own task worktree — a checkout of the *target*
 * project, which knows nothing about this repo — by absolute path:
 * `tsx <bottega>/reference/scripts/complete-plan.ts 42`. tsx reads
 * `paths` from the tsconfig.json it finds in the CURRENT WORKING DIRECTORY, not
 * next to the entry file, so a runtime (value) `@shared/*` import anywhere in a
 * script's module graph makes every one of those calls die with
 * ERR_MODULE_NOT_FOUND before a line of the script runs.
 *
 * Nothing else notices: `import type` is erased by the transformer, the server
 * itself runs with the repo as its cwd, and vitest mirrors the aliases
 * (vitest.config.ts). That is what makes the trap easy to walk into — and it
 * was, for real. The QA-step PR added a value import of `@shared/schemas/qa` to
 * `epicArchive.ts`, which `database/db.ts` reaches through `epicConversion.ts`;
 * from then on every stage-completion and block call an agent made failed,
 * silently as far as CI was concerned, for two weeks. So run the real commands
 * the way agents run them.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = path.join(appRoot, 'node_modules', '.bin', 'tsx');

// No task carries this id, so each script stops at its own "not found" check:
// far enough to prove the whole module graph loaded, short of writing a row.
const MISSING_TASK_ID = '2147483647';

// Every script named in server/constants/prompts/*.md and agentPrompts.ts,
// with the extra arguments its usage requires.
const SCRIPTS: Array<[script: string, extraArgs: string[]]> = [
  ['complete-plan.ts', []],
  ['complete-workflow.ts', []],
  ['complete-pr.ts', []],
  ['block-workflow.ts', ['needs outside help']],
];

/** Walk up from `dir`, returning the first tsconfig.json found. */
function findTsconfigAbove(dir: string): string | null {
  let current = dir;
  for (;;) {
    const candidate = path.join(current, 'tsconfig.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

describe('agent-invoked scripts load from the agent\'s cwd', () => {
  it.each(SCRIPTS)(
    '%s runs with this repo\'s tsconfig out of scope',
    (script, extraArgs) => {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-agent-cwd-'));
      try {
        // Otherwise the test could pass by borrowing someone else's aliases.
        expect(findTsconfigAbove(sandbox)).toBeNull();

        const result = spawnSync(
          tsx,
          [path.join(appRoot, 'scripts', script), MISSING_TASK_ID, ...extraArgs],
          {
            cwd: sandbox,
            encoding: 'utf8',
            timeout: 60_000,
            env: {
              ...process.env,
              // Never the real database or the real ~/.bottega archive.
              DATABASE_PATH: path.join(sandbox, 'bottega.db'),
              BOTTEGA_ARCHIVE_ROOT: path.join(sandbox, 'archive'),
            },
          },
        );

        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
        expect(output, `${script} failed to load:\n${output}`).not.toMatch(
          /ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module/,
        );
        expect(output).toContain(`Task with ID ${MISSING_TASK_ID} not found`);
      } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
