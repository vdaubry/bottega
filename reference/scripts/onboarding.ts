#!/usr/bin/env node

import bcrypt from 'bcrypt';
import prompts from 'prompts';

import { db, userDb, initializeDatabase } from '../server/database/db.js';
import { seedDemoProject } from '../server/services/demoSeeder.js';
import { DEMO_PROJECT_NAME } from '../server/services/demoSeederTemplates.js';

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

const c = {
  ok: (s: string) => `${colors.green}${s}${colors.reset}`,
  err: (s: string) => `${colors.red}${s}${colors.reset}`,
  warn: (s: string) => `${colors.yellow}${s}${colors.reset}`,
  info: (s: string) => `${colors.cyan}${s}${colors.reset}`,
  dim: (s: string) => `${colors.dim}${s}${colors.reset}`,
  bright: (s: string) => `${colors.bright}${s}${colors.reset}`,
};

function header(step: string): void {
  console.log('');
  console.log(c.bright(step));
  console.log(c.dim('─'.repeat(40)));
}

async function createAdminUser(): Promise<void> {
  if (userDb.hasUsers()) {
    console.log(c.ok('✓') + ' Admin user already exists, skipping.');
    return;
  }

  const onCancel = (): boolean => {
    console.log('');
    console.log(c.err('Aborted. No changes made.'));
    process.exit(130);
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const answers = await prompts(
      [
        {
          type: 'text',
          name: 'username',
          message: 'Username (min 3 chars):',
          validate: v => (typeof v === 'string' && v.trim().length >= 3) || 'At least 3 characters',
        },
        {
          type: 'password',
          name: 'password',
          message: 'Password (min 8 chars):',
          validate: v => (typeof v === 'string' && v.length >= 8) || 'At least 8 characters',
        },
        {
          type: 'password',
          name: 'confirm',
          message: 'Confirm password:',
        },
      ],
      { onCancel }
    );

    const username = (answers.username as string).trim();
    const password = answers.password as string;
    const confirm = answers.confirm as string;

    if (password !== confirm) {
      console.log(c.err('Passwords do not match. Try again.'));
      continue;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    try {
      db.prepare('BEGIN').run();
      const user = userDb.createUser(username, passwordHash);
      userDb.setAdmin(user.id, true);
      userDb.updateLastLogin(user.id);
      db.prepare('COMMIT').run();
      console.log(c.ok('✓') + ` Admin user '${c.bright(username)}' created.`);
      return;
    } catch (err) {
      try {
        db.prepare('ROLLBACK').run();
      } catch {
        // tx already closed; ignore
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
        console.log(c.err(`Username '${username}' is already taken. Try again.`));
        continue;
      }
      throw err;
    }
  }

  console.log(c.err('Too many failed attempts. Re-run `pnpm onboarding` to try again.'));
  process.exit(1);
}

async function seedDemo(): Promise<void> {
  const admin = userDb.getFirstAdmin();
  if (!admin) {
    console.log(c.err('No admin user found — cannot seed demo project.'));
    process.exit(1);
  }

  const result = await seedDemoProject(admin.id);

  if (result.skipped === 'already-seeded') {
    console.log(c.ok('✓') + ' Sample project already present, skipping.');
    return;
  }
  if (result.skipped === 'no-source') {
    console.log(
      c.warn('⚠ examples/landing-page/ not found, skipping demo seed.')
    );
    return;
  }
  console.log(
    c.ok('✓') +
      ` Created project '${c.bright(DEMO_PROJECT_NAME)}' with one sample task.`
  );
  console.log(c.dim(`  Repo path: ${result.repoPath}`));
}

async function main(): Promise<void> {
  console.log(c.bright('Bottega onboarding'));
  console.log(
    c.dim(
      'Two quick steps to get you running. Re-running is safe — completed steps are skipped.'
    )
  );

  await initializeDatabase();

  header('[1/2] Set up your admin account');
  await createAdminUser();

  header('[2/2] Seed the sample project');
  await seedDemo();

  console.log('');
  console.log(c.ok('All set.'));
  console.log(
    'Run ' + c.bright('pnpm dev') + ' and open ' + c.info('http://localhost:5173')
  );
  console.log('');
}

await main();
