#!/usr/bin/env node

import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { userDb, initializeDatabase } from '../server/database/db.js';

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function generatePassword(length: number = 16): string {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  const randomBytes = crypto.randomBytes(length);
  let password = '';

  for (let i = 0; i < length; i++) {
    password += charset[randomBytes[i]! % charset.length];
  }

  return password;
}

async function createUser(username: string): Promise<void> {
  // Validate username
  if (!username) {
    console.error(`${colors.red}Error:${colors.reset} Username is required`);
    console.log(`\nUsage: tsx scripts/create-user.ts <username>`);
    process.exit(1);
  }

  if (username.length < 3) {
    console.error(`${colors.red}Error:${colors.reset} Username must be at least 3 characters`);
    process.exit(1);
  }

  // Check if username already exists
  const existingUser = userDb.getUserByUsername(username);
  if (existingUser) {
    console.error(`${colors.red}Error:${colors.reset} Username "${username}" already exists`);
    process.exit(1);
  }

  // Generate password
  const password = generatePassword(16);

  // Hash password (same as auth.js - 12 salt rounds)
  const saltRounds = 12;
  const passwordHash = await bcrypt.hash(password, saltRounds);

  // Create user
  try {
    const user = userDb.createUser(username, passwordHash);

    console.log('');
    console.log(`${colors.green}${colors.bright}User created successfully!${colors.reset}`);
    console.log('');
    console.log(`${colors.dim}${'─'.repeat(40)}${colors.reset}`);
    console.log(`  ${colors.cyan}Username:${colors.reset} ${colors.bright}${username}${colors.reset}`);
    console.log(`  ${colors.cyan}Password:${colors.reset} ${colors.bright}${password}${colors.reset}`);
    console.log(`  ${colors.cyan}User ID:${colors.reset}  ${user.id}`);
    console.log(`${colors.dim}${'─'.repeat(40)}${colors.reset}`);
    console.log('');
    console.log(`${colors.yellow}Store this password securely - it cannot be retrieved later.${colors.reset}`);
    console.log('');

  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: string }).code : undefined;
    if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
      console.error(`${colors.red}Error:${colors.reset} Username "${username}" already exists`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${colors.red}Error:${colors.reset} Failed to create user:`, message);
    }
    process.exit(1);
  }
}

// Main
const username = process.argv[2];
if (!username) {
  console.error('Usage: tsx scripts/create-user.ts <username>');
  process.exit(1);
}

// Initialize database (ensures schema exists)
await initializeDatabase();

// Create the user
await createUser(username);
