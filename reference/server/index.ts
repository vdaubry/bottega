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
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import cors from 'cors';
import { promises as fsPromises } from 'fs';

import { getAllActiveStreamingSessions } from './services/conversationAdapter.js';
import {
  dispatchClientMessage,
  cleanupClientSubscriptions,
  makeBroadcastToTaskSubscribers,
  makeBroadcastToConversationSubscribers,
} from './websocket/dispatch.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/account.js';
import claudeAuthRoutes from './routes/claudeAuth.js';
import codexAuthRoutes from './routes/codexAuth.js';
import openCodeAuthRoutes from './routes/openCodeAuth.js';
import commandsRoutes from './routes/commands.js';
import projectsRoutes from './routes/projects.js';
import tasksRoutes from './routes/tasks.js';
import conversationsRoutes from './routes/conversations.js';
import agentRunsRoutes from './routes/agent-runs.js';
import webServerRoutes from './routes/webServer.js';
import adminRoutes from './routes/admin.js';
import webhooksRoutes from './routes/webhooks.js';
import settingsRoutes from './routes/settings.js';
import appSettingsRoutes from './routes/appSettings.js';
import userAgentModelSettingsRoutes from './routes/userAgentModelSettings.js';
import { initializeDatabase, agentRunsDb } from './database/db.js';
import { getProject } from './services/projectService.js';
import { transcribeAudio } from './services/transcription.js';
import {
  authenticateToken,
  requireAdmin,
  authenticateWebSocket,
  ensureJwtSecret,
  REFRESHED_TOKEN_HEADER,
} from './middleware/auth.js';
import type { WebSocketUser } from './middleware/auth.js';

interface AugmentedIncomingMessage extends http.IncomingMessage {
  user?: WebSocketUser;
}

interface HeartbeatWebSocket extends WebSocket {
  isAlive?: boolean;
}

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

function getSafeRequestPath(rawUrl: string | undefined): string {
  try {
    return new URL(rawUrl ?? '', 'http://localhost').pathname;
  } catch {
    return '[invalid-url]';
  }
}

// Single WebSocket server that handles both paths
const wss = new WebSocketServer({
  server,
  verifyClient: (info: { req: AugmentedIncomingMessage }) => {
    console.log('WebSocket connection attempt to:', getSafeRequestPath(info.req.url));

    const url = new URL(info.req.url ?? '', 'http://localhost');
    const token =
      url.searchParams.get('token') || info.req.headers.authorization?.split(' ')[1];

    const user = authenticateWebSocket(token);
    if (!user) {
      console.log('[WARN] WebSocket authentication failed');
      return false;
    }

    info.req.user = user;
    console.log('[OK] WebSocket authenticated for user:', user.username);
    return true;
  },
});

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

app.locals.wss = wss;
app.locals.broadcastToTaskSubscribers = broadcastToTaskSubscribers;
app.locals.broadcastToConversationSubscribers = broadcastToConversationSubscribers;

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
app.use('/api', authenticateToken, conversationsRoutes);
app.use('/api', authenticateToken, agentRunsRoutes);
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

wss.on('connection', (ws: WebSocket, request: AugmentedIncomingMessage) => {
  const url = request.url;
  console.log('[INFO] Client connected to:', getSafeRequestPath(url));

  const urlObj = new URL(url ?? '', 'http://localhost');
  const pathname = urlObj.pathname;

  if (pathname === '/ws') {
    handleChatConnection(ws, request);
  } else {
    console.log('[WARN] Unknown WebSocket path:', pathname);
    ws.close();
  }
});

function handleChatConnection(ws: WebSocket, request: AugmentedIncomingMessage): void {
  console.log('[INFO] Chat WebSocket connected');

  const hws = ws as HeartbeatWebSocket;
  hws.isAlive = true;
  ws.on('pong', () => {
    hws.isAlive = true;
  });

  const userId = request?.user?.id;
  const ctx = {
    ws,
    wss,
    userId,
    broadcastToTaskSubscribersFn: broadcastToTaskSubscribers,
    broadcastToConversationSubscribersFn: broadcastToConversationSubscribers,
  };

  ws.on('message', async (message: Buffer | ArrayBuffer | Buffer[]) => {
    let data: unknown;
    try {
      const text = Array.isArray(message)
        ? Buffer.concat(message).toString('utf8')
        : Buffer.from(message as ArrayBuffer).toString('utf8');
      data = JSON.parse(text);
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : JSON.stringify(error);
      console.error('[ERROR] Chat WebSocket parse error:', errMessage);
      ws.send(JSON.stringify({ type: 'error', error: errMessage }));
      return;
    }

    if (typeof (data as { type?: unknown })?.type !== 'string') {
      // Malformed/unknown payload — silently drop, matching prior behavior.
      return;
    }

    try {
      await dispatchClientMessage(ctx, data as Parameters<typeof dispatchClientMessage>[1]);
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket dispatch error:', errMessage);
      ws.send(JSON.stringify({ type: 'error', error: errMessage }));
    }
  });

  ws.on('close', () => {
    console.log('🔌 Chat client disconnected');
    cleanupClientSubscriptions(ws);
  });
}

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

    const orphanedRuns = agentRunsDb.getByStatus('running');
    if (orphanedRuns.length > 0) {
      for (const run of orphanedRuns) {
        agentRunsDb.updateStatus(run.id, 'failed');
      }
      console.log(
        `[RECOVERY] Marked ${orphanedRuns.length} orphaned agent run(s) as failed: ${orphanedRuns.map((r) => `#${r.id} (${r.agent_type} for task ${r.task_id})`).join(', ')}`,
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

process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('[Server] HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[Server] SIGINT received, shutting down gracefully...');
  server.close(() => {
    console.log('[Server] HTTP server closed');
    process.exit(0);
  });
});

void startServer();
