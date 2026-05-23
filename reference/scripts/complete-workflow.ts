#!/usr/bin/env node

/**
 * CLI script to mark a task's workflow as complete.
 * Used by Claude agents to signal that the implementation loop should stop.
 *
 * Usage: tsx scripts/complete-workflow.ts <taskId>
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

async function completeWorkflow(taskId: string | undefined): Promise<void> {
  // Validate taskId
  if (!taskId) {
    console.error(`${colors.red}Error:${colors.reset} Task ID is required`);
    console.log(`\nUsage: tsx scripts/complete-workflow.ts <taskId>`);
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
  if (task.workflow_complete) {
    console.log(`${colors.cyan}Info:${colors.reset} Task ${parsedTaskId} workflow is already marked as complete`);
    process.exit(0);
  }

  // Update task to mark workflow as complete
  try {
    const updatedTask = tasksDb.update(parsedTaskId, { workflow_complete: 1 });

    console.log('');
    console.log(`${colors.green}${colors.bright}Workflow marked as complete!${colors.reset}`);
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

// Mark workflow as complete
await completeWorkflow(taskId);
