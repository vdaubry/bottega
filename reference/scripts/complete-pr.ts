#!/usr/bin/env node

/**
 * CLI script to mark a task's PR agent as complete.
 * Called by PR agent when CI passes.
 *
 * Usage: tsx scripts/complete-pr.ts <taskId>
 *
 * **Refuses on a worktree that still holds unpublished work.** This is the last
 * gate before a task is closed out, and the worktree is deleted when its PR
 * merges — so anything still sitting in it (an uncommitted edit, a commit that
 * never left the box) is about to be discarded. The PR agent's prompt tells it to
 * triage and publish; this check is what makes that non-optional, because the
 * failure it prevents is silent: a stage signs off against a commit that predates
 * the work, CI goes green on it, and the loss only surfaces after the merge.
 *
 * The escape hatch for a human is the UI, not a flag here: marking the task's
 * workflow complete (`PATCH /api/tasks/:id/workflow-complete`) sets
 * `pr_agent_complete` directly. An agent gets no way around the gate.
 */

import { tasksDb, initializeDatabase } from '../server/database/db.js';
import { getTaskPublishState, MAX_LISTED_FILES } from '../server/services/prService.js';

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

async function completePrAgent(taskId: string | undefined): Promise<void> {
  // Validate taskId
  if (!taskId) {
    console.error(`${colors.red}Error:${colors.reset} Task ID is required`);
    console.log(`\nUsage: tsx scripts/complete-pr.ts <taskId>`);
    process.exit(1);
  }

  const parsedTaskId = parseInt(taskId, 10);
  if (isNaN(parsedTaskId)) {
    console.error(`${colors.red}Error:${colors.reset} Task ID must be a number`);
    process.exit(1);
  }

  // Check if task exists
  const task = tasksDb.getById(parsedTaskId);
  if (!task) {
    console.error(`${colors.red}Error:${colors.reset} Task with ID ${parsedTaskId} not found`);
    process.exit(1);
  }

  // Check if already complete
  if (task.pr_agent_complete) {
    console.log(`${colors.cyan}Info:${colors.reset} Task ${parsedTaskId} PR agent is already marked as complete`);
    process.exit(0);
  }

  // Refuse while the worktree still holds work the PR does not have.
  const publishState = await getTaskPublishState(parsedTaskId);
  if (!publishState.published) {
    console.error('');
    console.error(
      `${colors.red}${colors.bright}Refusing to complete: this worktree still holds unpublished work.${colors.reset}`,
    );
    console.error(`${colors.cyan}Worktree:${colors.reset} ${publishState.worktreePath}`);
    console.error(`${colors.cyan}Unpublished:${colors.reset} ${publishState.summary}`);
    if (publishState.files.length > 0) {
      console.error('');
      for (const file of publishState.files) {
        console.error(`  ${file}`);
      }
      if (publishState.dirtyFiles > publishState.files.length) {
        console.error(`  … and ${publishState.dirtyFiles - MAX_LISTED_FILES} more`);
      }
    }
    console.error('');
    console.error(
      'This worktree is deleted when the PR merges, so anything left here is lost. Triage it:',
    );
    console.error(
      '  - byproducts of getting here (QA screenshots and recordings, traces, logs,',
    );
    console.error('    coverage output, scratch or one-off scripts, *.bak): delete them');
    console.error('  - everything else: commit it and push it, so it reaches the PR');
    console.error('Then run this script again.');
    console.error('');
    process.exit(1);
  }

  // Update task to mark PR agent as complete
  try {
    const updatedTask = tasksDb.markPrAgentComplete(parsedTaskId);

    console.log('');
    console.log(`${colors.green}${colors.bright}PR agent marked as complete!${colors.reset}`);
    console.log(`${colors.cyan}Task ID:${colors.reset} ${parsedTaskId}`);
    console.log(`${colors.cyan}Title:${colors.reset} ${updatedTask?.title || '(no title)'}`);
    console.log('');

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${colors.red}Error:${colors.reset} Failed to update task:`, message);
    process.exit(1);
  }
}

// Main
const taskId = process.argv[2];

// Initialize database (ensures schema and migrations are run)
await initializeDatabase();

// Mark PR agent as complete
await completePrAgent(taskId);
