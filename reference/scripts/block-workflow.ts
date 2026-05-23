#!/usr/bin/env node

/**
 * CLI script to block a task's workflow.
 * Used by Claude agents to signal that user intervention is needed
 * and the implementation/review loop should pause.
 *
 * Usage: tsx scripts/block-workflow.ts <taskId>
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

async function blockWorkflow(taskId: string | undefined): Promise<void> {
  // Validate taskId
  if (!taskId) {
    console.error(`${colors.red}Error:${colors.reset} Task ID is required`);
    console.log(`\nUsage: tsx scripts/block-workflow.ts <taskId>`);
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
    const updatedTask = tasksDb.blockWorkflow(parsedTaskId);

    console.log('');
    console.log(`${colors.yellow}${colors.bright}Workflow blocked - waiting for user intervention${colors.reset}`);
    console.log(`${colors.cyan}Task ID:${colors.reset} ${parsedTaskId}`);
    console.log(`${colors.cyan}Title:${colors.reset} ${updatedTask?.title || '(no title)'}`);
    console.log('');

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${colors.red}Error:${colors.reset} Failed to block workflow:`, message);
    process.exit(1);
  }
}

// Main
const taskId = process.argv[2];

// Initialize database (ensures schema and migrations are run)
await initializeDatabase();

// Block the workflow
await blockWorkflow(taskId);
