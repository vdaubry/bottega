# Bottega — Project Documentation

Bottega is a web-based interface for the Claude Code CLI: a desktop/mobile-friendly UI for managing coding projects and driving Claude (and Codex/OpenCode) through structured agentic workflows.

> **This is the narrative overview + folder map.** The authoritative per-doc
> index — every doc with a one-sentence "when to read it" — lives in the
> autoloaded **`../CLAUDE.md`** table. Read that first; pull only the docs whose
> "when to read" matches your task before exploring code.

## Core concept

The app uses a **task-driven development model**:

- **Project** — a database row pointing to a git repository on disk.
- **Task** — a unit of work with markdown documentation, its own git worktree, and workflow flags that gate the agentic loop.
- **Conversation** — a provider session linked to a task. Manual chats and agent runs both create conversations.

Users create projects, define tasks, and either chat with a model scoped to a task or launch automated agents that plan → implement → review → refine → PR with optional GitHub-webhook re-triggering on PR comments.

### Explore (Schema generation)

The **Explore** button on the task page opens the `/ide` view directly on its
**Schema** tab. On first entry, when the task has no `plan` artifact yet, the
Schema tab **auto-generates** one and renders it as a self-contained interactive
HTML diagram; on re-entry it shows the existing artifact without regenerating. A
slim toolbar lets you produce other kinds (`flowchart`/`architecture`). Schema
generation is **Anthropic-only** (the in-process code-atlas engine attaches to
the Claude Agent SDK only) and is configured under **Settings → Agent Models →
Schema**. Details in [`atlas/`](./atlas/schema-generation.md).

### Switch server (live worktree preview)

The **Switch Server** button repoints a project's NGINX-served symlink at a
task's git worktree (or back at the main repo), so you can preview a branch at
the project's public URL without a separate deploy. After flipping the symlink,
Bottega runs an optional per-project hook — **`.bottega/switch.sh`** — falling
back to `systemctl --user restart` when no hook is present. Full contract in
[`web-server/switch-server.md`](./web-server/switch-server.md).

## Architecture at a glance

```
┌──────────────────────────────────────────────────────────────────┐
│                          Frontend                                 │
│                React 18 + Vite + Tailwind + CodeMirror            │
│                                                                   │
│  Dashboard ──► Board (Kanban) ──► Task Detail ──► Chat            │
│  (projects)    (3 columns)        (docs + convos)  (messages)     │
└──────────────────────────────────────────────────────────────────┘
                      │ REST (/api/*)          │ WebSocket (/ws?token=)
                      ▼                        ▼
┌──────────────────────────────────────────────────────────────────┐
│                          Backend                                  │
│              Node.js + Express + ws + better-sqlite3              │
│                                                                   │
│  routes/*  ──►  services/conversation/* (lifecycle + streaming)   │
│                 services/providers/*      (anthropic/codex/opencode)│
│                 services/agentRunner.ts   (agent loop)            │
│                 services/worktree.ts      (git worktrees)         │
│                 services/atlas/*          (Explore code-atlas)    │
│                 websocket/dispatch.ts     (3 subscribe channels)  │
└──────────────────────────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────────────────┐
│  Provider SDKs (one subprocess / session per conversation)        │
│  SQLite (server/database/bottega.db) — ALL metadata + transcripts │
│     ├─ Domain: users, projects, project_members, tasks,           │
│     │  conversations, task_agent_runs, task_artifacts, settings   │
│     └─ Transcripts: messages, session_summaries (the SDK's        │
│        sessionStore backend — single source of truth)             │
│  Filesystem: ~/.bottega/ (task docs, prompt overrides, archives)  │
│              ~/.config/bottega/users/{id}/ (Claude OAuth)         │
│              {repo}-worktrees/task-{id}/  (per-task git worktree) │
└──────────────────────────────────────────────────────────────────┘
```

## Documentation folder map

This tree is organized by **architectural domain** — each domain folder holds
both the backend and frontend docs for that vertical slice, so a feature is one
read. Three cross-cutting folders hold infrastructure no single domain owns.
The per-doc "when to read it" table is in **`../CLAUDE.md`**.

| Folder | Covers |
|---|---|
| `architecture/` | cross-cutting structure: data model, WebSocket protocol, repo layout |
| `backend/` | server plumbing: REST catalog, startup bootstrap, background services |
| `frontend/` | client architecture: the app shell + state/realtime transport |
| `auth/` | app auth (JWT + API keys) and the project-membership authorization model |
| `providers/` | the Claude/Codex/OpenCode abstraction, credentials, connection UI |
| `conversations/` | conversation lifecycle, streaming, features, the chat UI |
| `agents/` | the agentic loop, prompts, worktrees/PR, GitHub webhooks, agent UI |
| `tasks/` | the projects/tasks/conversations domain + the 4-screen UI flow |
| `atlas/` | Explore: code-atlas schema generation + the IDE view |
| `web-server/` | the "switch server" live-preview feature |

## Tech stack

- **Frontend**: React 18, Vite, React Router, Tailwind CSS, CodeMirror.
- **Backend**: Node.js (`tsx` for dev), Express, `ws`, `better-sqlite3`, `node-pty` (provider login PTYs), `bcrypt`, `jsonwebtoken`.
- **Providers**: Anthropic via `@anthropic-ai/claude-agent-sdk`; OpenAI Codex; OpenCode (out-of-process HTTP+SSE). OpenAI `gpt-4o-transcribe` for voice input.
- **TypeScript-only.** `tsconfig.json` sets `allowJs: false`; the `pnpm guard-no-js` prelint hook fails CI on any new `.js`/`.jsx`. See [`architecture/repository-layout.md`](./architecture/repository-layout.md).

## Running locally

```bash
corepack enable          # provisions pnpm at the pinned version
pnpm install
pnpm dev                 # frontend :5173, backend :3002
pnpm test:run            # unit + integration tests (Vitest)
```

`JWT_SECRET` is required in `.env` (`openssl rand -hex 64`); `OPENAI_API_KEY` for voice input; `GITHUB_WEBHOOK_SECRET` for the PR-comment trigger. Per-user Claude OAuth is provisioned through the in-app login flow (Settings → Connect Claude) — see [`providers/claude.md`](./providers/claude.md).
