#!/usr/bin/env node

/**
 * CLI script to mark a task's PR agent as complete.
 * Called by PR agent when CI passes.
 *
 * Usage: tsx scripts/complete-pr.ts <taskId>
 */

import { tasksDb, initializeDatabase } from '../server/database/db.js';

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
