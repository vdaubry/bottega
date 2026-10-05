#!/usr/bin/env node
// Load environment variables from .env file
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  dim: '\x1b[2m',
};

const c = {
  info: (text: string) => `${colors.cyan}${text}${colors.reset}`,
  ok: (text: string) => `${colors.green}${text}${colors.reset}`,
  warn: (text: string) => `${colors.yellow}${text}${colors.reset}`,
  tip: (text: string) => `${colors.blue}${text}${colors.reset}`,
  bright: (text: string) => `${colors.bright}${text}${colors.reset}`,
  dim: (text: string) => `${colors.dim}${text}${colors.reset}`,
};

try {
  const envPath = path.join(__dirname, '../.env');
  const envFile = fs.readFileSync(envPath, 'utf8');
  envFile.split('\n').forEach((line) => {
    const trimmedLine = line.trim();
    if (trimmedLine && !trimmedLine.startsWith('#')) {
      const [key, ...valueParts] = trimmedLine.split('=');
      if (key && valueParts.length > 0 && !process.env[key]) {
        process.env[key] = valueParts.join('=').trim();
      }
    }
  });
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  console.log('No .env file found or error reading it:', message);
}

console.log('PORT from env:', process.env.PORT);

import express, { type Request, type Response } from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import cors from 'cors';
import { promises as fsPromises } from 'fs';

import { getAllActiveStreamingSessions } from './services/conversationAdapter.js';
import {
  makeBroadcastToTaskSubscribers,
  makeBroadcastToConversationSubscribers,
  makeBroadcastToAtlasSubscribers,
  makeGetAtlasSubscriberCount,
  makeBroadcastToEpicSubscribers,
} from './websocket/dispatch.js';
import { initAtlasBridge } from './services/atlas/bridge.js';
import { makeConnectionHandler, type HeartbeatWebSocket } from './websocket/connection.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/account.js';
import claudeAuthRoutes from './routes/claudeAuth.js';
import codexAuthRoutes from './routes/codexAuth.js';
import openCodeAuthRoutes from './routes/openCodeAuth.js';
import commandsRoutes from './routes/commands.js';
import projectsRoutes from './routes/projects.js';
import tasksRoutes from './routes/tasks.js';
import atlasRoutes from './routes/atlas.js';
import conversationsRoutes from './routes/conversations.js';
import agentRunsRoutes from './routes/agent-runs.js';
import epicsRoutes from './routes/epics.js';
import webServerRoutes from './routes/webServer.js';
import adminRoutes from './routes/admin.js';
import webhooksRoutes from './routes/webhooks.js';
import settingsRoutes from './routes/settings.js';
import appSettingsRoutes from './routes/appSettings.js';
import userAgentModelSettingsRoutes from './routes/userAgentModelSettings.js';
import { initializeDatabase } from './database/db.js';
import { databasePath } from './database/connection.js';
import { claimDatabaseOwnership, releaseDatabaseOwnership } from './database/ownership.js';
import { initEpics, resumeOrchestrationAfterRestart } from './services/epics/index.js';
import { initTasks } from './services/tasks/adapter.js';
import { onTaskEvent } from './services/tasks/events.js';
import {
  abortAllWorktreeSetups,
  failInterruptedWorktreeSetups,
} from './services/tasks/worktreeSetup.js';
import { reconcileTaskLandings } from './services/tasks/index.js';
import { sweepAllOwnerOrphans } from './services/conversation/ownerAdapters.js';
import { getProject } from './services/projectService.js';
import { transcribeAudio } from './services/transcription.js';
import {
  authenticateToken,
  requireAdmin,
  ensureJwtSecret,
  REFRESHED_TOKEN_HEADER,
} from './middleware/auth.js';
import { verifyClient } from './websocket/verifyClient.js';
import { installProcessGuards } from './processGuards.js';

interface FileTreeItem {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size?: number;
  modified?: string | null;
  permissions?: string;
  permissionsRwx?: string;
  children?: FileTreeItem[];
}

const app = express();
const server = http.createServer(app);

// Single WebSocket server that handles both paths. Authentication happens in
// `verifyClient` (websocket/verifyClient.ts), which also owns the one failure
// that used to escape from here: a locked database throwing out of the
// synchronous credential lookup, in a hook `ws` runs straight off the HTTP
// server's `upgrade` event where nothing else could catch it.
const wss = new WebSocketServer({ server, verifyClient });

// WebSocket heartbeat to detect stale connections
const HEARTBEAT_INTERVAL = 30000;

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    const hws = ws as HeartbeatWebSocket;
    if (hws.isAlive === false) {
      console.log('[WS] Terminating stale connection');
      return ws.terminate();
    }
    hws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

const broadcastToTaskSubscribers = makeBroadcastToTaskSubscribers(wss);
const broadcastToConversationSubscribers =
  makeBroadcastToConversationSubscribers(wss);

// Explore (code-atlas) channel: the MCP tools push UI commands through the
// bridge, which fans out to atlas subscribers and waits for their acks.
initAtlasBridge({
  broadcast: makeBroadcastToAtlasSubscribers(wss),
  getSubscriberCount: makeGetAtlasSubscriberCount(wss),
});

// Epic channel: epic-scoped lifecycle events (agent runs, conversations,
// streaming badges) for open epic pages — the epic's equivalent of the task
// channel.
const broadcastToEpicSubscribers = makeBroadcastToEpicSubscribers(wss);

app.locals.wss = wss;
app.locals.broadcastToTaskSubscribers = broadcastToTaskSubscribers;
app.locals.broadcastToConversationSubscribers = broadcastToConversationSubscribers;
app.locals.broadcastToEpicSubscribers = broadcastToEpicSubscribers;

// Wire the epic domain up: its event bridge starts conversation turns from
// places that have no request to read `app.locals` off — a completion hook,
// the boot reconciliation below — so it gets the same three closures through
// a registry; and its TaskEvents subscription is what makes it react to
// ticket turns at all.
initTasks();
// A task's worktree is set up in the background after creation; its outcome
// reaches open task pages and boards over the task channel.
onTaskEvent('worktree-state-changed', ({ taskId, state, error }) => {
  broadcastToTaskSubscribers(taskId, {
    type: 'task-worktree-updated',
    worktreeState: state,
    worktreeError: error,
  });
});
initEpics({
  broadcastFn: broadcastToConversationSubscribers,
  broadcastToTaskSubscribersFn: broadcastToTaskSubscribers,
  broadcastToEpicSubscribersFn: broadcastToEpicSubscribers,
});

// Expose the sliding-refresh JWT header so browser fetch() callers can read it.
app.use(cors({ exposedHeaders: [REFRESHED_TOKEN_HEADER] }));

// Webhook routes - must be before express.json() to get raw body for signature validation
app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhooksRoutes);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/auth', authRoutes);

app.use('/api/app-settings', appSettingsRoutes);

app.use('/api/account', accountRoutes);

app.use('/api/claude-auth', authenticateToken, claudeAuthRoutes);
app.use('/api/codex-auth', authenticateToken, codexAuthRoutes);
app.use('/api/opencode-auth', authenticateToken, openCodeAuthRoutes);

app.use('/api/commands', authenticateToken, commandsRoutes);

app.use('/api/projects', authenticateToken, projectsRoutes);
app.use('/api', authenticateToken, tasksRoutes);
app.use('/api', authenticateToken, atlasRoutes);
app.use('/api', authenticateToken, conversationsRoutes);
app.use('/api', authenticateToken, agentRunsRoutes);
app.use('/api', authenticateToken, epicsRoutes);
app.use('/api', authenticateToken, webServerRoutes);
app.use('/api/settings', authenticateToken, settingsRoutes);
app.use('/api/user-agent-model-settings', authenticateToken, userAgentModelSettingsRoutes);

app.use('/api/admin', authenticateToken, requireAdmin, adminRoutes);

app.get('/api/streaming-sessions', authenticateToken, (req, res) => {
  const sessions = getAllActiveStreamingSessions(req.user?.id);
  res.json({ sessions });
});

app.use(express.static(path.join(__dirname, '../public')));

app.get('/api/projects/:id/files', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const projectId = parseInt(req.params.id as string, 10);

    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid project ID' });
      return;
    }

    const project = getProject(projectId, userId);

    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const fileTree = await getFileTree(project.repo_folder_path, 4, 0, false);
    res.json(fileTree);
  } catch (error) {
    console.error('Error getting project files:', error);
    res.status(500).json({ error: 'Failed to get project files' });
  }
});

// Everything that happens on an accepted socket — the 'error' guard, the
// path routing, the chat message loop — lives in websocket/connection.ts so
// it can run against a real WebSocketServer under test.
wss.on(
  'connection',
  makeConnectionHandler({
    wss,
    broadcastToTaskSubscribersFn: broadcastToTaskSubscribers,
    broadcastToConversationSubscribersFn: broadcastToConversationSubscribers,
    broadcastToEpicSubscribersFn: broadcastToEpicSubscribers,
  }),
);

app.post('/api/transcribe', authenticateToken, async (req: Request, res: Response) => {
  try {
    const multer = (await import('multer')).default;
    const upload = multer({ storage: multer.memoryStorage() });

    upload.single('audio')(req, res, async (err: unknown) => {
      if (err) {
        res.status(400).json({ error: 'Failed to process audio file' });
        return;
      }

      if (!req.file) {
        res.status(400).json({ error: 'No audio file provided' });
        return;
      }

      try {
        const buffer = req.file.buffer;
    const text = await transcribeAudio(buffer);
        res.json({ text });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Transcription error:', error);
        res.status(500).json({ error: message });
      }
    });
  } catch (error) {
    console.error('Endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function permToRwx(perm: number): string {
  const r = perm & 4 ? 'r' : '-';
  const w = perm & 2 ? 'w' : '-';
  const x = perm & 1 ? 'x' : '-';
  return r + w + x;
}

async function getFileTree(
  dirPath: string,
  maxDepth: number = 3,
  currentDepth: number = 0,
  showHidden: boolean = true,
): Promise<FileTreeItem[]> {
  const items: FileTreeItem[] = [];

  try {
    const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      // Skip only heavy build directories
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue;

      const itemPath = path.join(dirPath, entry.name);
      const item: FileTreeItem = {
        name: entry.name,
        path: itemPath,
        type: entry.isDirectory() ? 'directory' : 'file',
      };

      try {
        const stats = await fsPromises.stat(itemPath);
        item.size = stats.size;
        item.modified = stats.mtime.toISOString();

        const mode = stats.mode;
        const ownerPerm = (mode >> 6) & 7;
        const groupPerm = (mode >> 3) & 7;
        const otherPerm = mode & 7;
        item.permissions =
          ((mode >> 6) & 7).toString() + ((mode >> 3) & 7).toString() + (mode & 7).toString();
        item.permissionsRwx = permToRwx(ownerPerm) + permToRwx(groupPerm) + permToRwx(otherPerm);
      } catch {
        item.size = 0;
        item.modified = null;
        item.permissions = '000';
        item.permissionsRwx = '---------';
      }

      if (entry.isDirectory() && currentDepth < maxDepth) {
        try {
          await fsPromises.access(item.path, fs.constants.R_OK);
          item.children = await getFileTree(item.path, maxDepth, currentDepth + 1, showHidden);
        } catch {
          item.children = [];
        }
      }

      items.push(item);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') {
      console.error('Error reading directory:', error);
    }
  }

  return items.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

const PORT = process.env.PORT || 3001;

async function startServer(): Promise<void> {
  try {
    // Refuse to start without a real JWT_SECRET — better to crash loudly than
    // sign tokens with a guessable default.
    ensureJwtSecret();

    await initializeDatabase();

    // Crash recovery, and only for the server that owns this database. Each
    // action below assumes the mid-flight state it finds is wreckage this
    // process left behind on its way down. That holds for a restart; it does
    // not hold for a second server sharing the file (a worktree dev server
    // whose `server/database/bottega.db` symlinks to the live one), where the
    // same actions would fail runs another server is actively streaming,
    // remove its worktrees, and wake its orchestrators.
    const ownership = claimDatabaseOwnership(databasePath);
    if (ownership.owned) {
      // Each owner domain sweeps its own orphans: runs left 'running' by the
      // restart are failed (task and epic tables alike).
      sweepAllOwnerOrphans();

      // Worktree setups that were running died with the previous process:
      // mark them failed so those tasks offer Retry instead of staying stuck.
      failInterruptedWorktreeSetups();

      // Repair the one cross-system crash window before epic sequencing reads
      // task status: a persisted merge request whose PR reached MERGED while the
      // process was dying. Large worktree cleanups continue in the background;
      // only the authoritative GitHub -> SQLite reconciliation is startup work.
      await reconcileTaskLandings();

      // Epics under orchestration self-heal across restarts (see
      // services/epics/index.ts for why).
      resumeOrchestrationAfterRestart();
    } else {
      const owner = ownership.heldBy;
      console.warn(
        `${c.warn('[WARN]')} Another server owns ${ownership.databasePath}` +
          (owner ? ` (pid ${owner.pid}, started ${owner.startedAt}, at ${owner.install})` : '') +
          ' — skipping crash recovery: no orphan sweep, no landing reconciliation, ' +
          'no orchestrator resume. Its in-flight runs are not yours to fail.',
      );
      console.warn(
        `${c.warn('[WARN]')} This server still shares that database. ` +
          'Set DATABASE_PATH to a copy to work in isolation.',
      );
    }

    console.log(`${c.info('[INFO]')} Using Claude Agents SDK for Claude integration`);
    console.log(
      `${c.info('[INFO]')} Frontend served by Vite at ${c.dim('http://localhost:' + (process.env.VITE_PORT || 5173))}`,
    );

    server.listen(Number(PORT), '0.0.0.0', () => {
      const appInstallPath = path.join(__dirname, '..');

      console.log('');
      console.log(c.dim('═'.repeat(63)));
      console.log(`  ${c.bright('Bottega Server - Ready')}`);
      console.log(c.dim('═'.repeat(63)));
      console.log('');
      console.log(`${c.info('[INFO]')} Server URL:  ${c.bright('http://0.0.0.0:' + PORT)}`);
      console.log(`${c.info('[INFO]')} Installed at: ${c.dim(appInstallPath)}`);
      console.log(`${c.tip('[TIP]')}  Run "cloudcli status" for full configuration details`);
      console.log('');
    });
  } catch (error) {
    console.error('[ERROR] Failed to start server:', error);
    process.exit(1);
  }
}

// Hand the database back on the way out, so the next boot recovers instead of
// reading our stale pid. No-ops unless we hold the lock — a dev server exiting
// must not release the live service's claim.
function shutdown(signal: string): void {
  console.log(`[Server] ${signal} received, shutting down gracefully...`);
  // Stop running worktree setups (their hooks lead their own process groups,
  // so nothing else would). The next owner's boot marks those tasks failed.
  abortAllWorktreeSetups();
  releaseDatabaseOwnership(databasePath);
  server.close(() => {
    console.log('[Server] HTTP server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('SIGINT', () => shutdown('SIGINT'));

// The last-resort `uncaughtException` / `unhandledRejection` handlers. There
// were none: the one lock timeout an authenticated request hit on 2026-09-04
// took the whole server down. The policy — keep serving through a SQLITE_BUSY
// that nothing caught, exit on anything else exactly as Node would — and the
// reasoning behind it are in processGuards.ts.
installProcessGuards();

void startServer();
