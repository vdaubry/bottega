#!/usr/bin/env node

/**
 * CLI script to block a task's workflow.
 * Used by agents to signal that outside help is needed and the
 * implementation/review loop should pause.
 *
 * The reason is not decoration: when the task is an epic ticket, it is the
 * message the epic orchestrator is woken with, and the orchestrator decides
 * from it whether this is something it can fix itself. A block with no reason
 * sends the orchestrator hunting through the ticket document instead.
 *
 * Usage: tsx scripts/block-workflow.ts <taskId> [reason...]
 */

import { tasksDb, initializeDatabase } from '../server/database/db.js';

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
};

async function blockWorkflow(
  taskId: string | undefined,
  reason: string | null,
): Promise<void> {
  // Validate taskId
  if (!taskId) {
    console.error(`${colors.red}Error:${colors.reset} Task ID is required`);
    console.log(`\nUsage: tsx scripts/block-workflow.ts <taskId> [reason...]`);
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

  // Check if already blocked
  if (task.workflow_blocked) {
    console.log(`${colors.cyan}Info:${colors.reset} Task ${parsedTaskId} workflow is already blocked`);
    process.exit(0);
  }

  // Check if workflow is already complete
  if (task.workflow_complete) {
    console.log(`${colors.cyan}Info:${colors.reset} Task ${parsedTaskId} workflow is already complete, cannot block`);
    process.exit(0);
  }

  // Block the workflow
  try {
    const updatedTask = tasksDb.blockWorkflow(parsedTaskId, reason);

    console.log('');
    console.log(`${colors.yellow}${colors.bright}Workflow blocked - waiting for intervention${colors.reset}`);
    console.log(`${colors.cyan}Task ID:${colors.reset} ${parsedTaskId}`);
    console.log(`${colors.cyan}Title:${colors.reset} ${updatedTask?.title || '(no title)'}`);
    console.log(
      `${colors.cyan}Reason:${colors.reset} ${updatedTask?.workflow_blocked_reason || '(none given)'}`,
    );
    if (!reason) {
      console.log(
        `${colors.yellow}Hint:${colors.reset} pass the reason as arguments — ` +
          `tsx scripts/block-workflow.ts ${parsedTaskId} "what is blocking and what you tried"`,
      );
    }
    console.log('');

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${colors.red}Error:${colors.reset} Failed to block workflow:`, message);
    process.exit(1);
  }
}

// Main
const taskId = process.argv[2];
// Everything after the id is the reason, quoted or not.
const reason = process.argv.slice(3).join(' ').trim() || null;

// Initialize database (ensures schema and migrations are run)
await initializeDatabase();

// Block the workflow
await blockWorkflow(taskId, reason);
