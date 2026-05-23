# Bottega — Project Documentation

Bottega is a web-based interface for the Claude Code CLI: a desktop/mobile-friendly UI for managing coding projects and driving Claude through structured agentic workflows.

## Core concept

The app uses a **task-driven development model**:

- **Project** — a database row pointing to a git repository on disk.
- **Task** — a unit of work with markdown documentation, its own git worktree, and workflow flags that gate the agentic loop.
- **Conversation** — a Claude session linked to a task. Manual chats and agent runs both create conversations.

Users create projects, define tasks, and either chat with Claude scoped to a task or launch automated agents that plan → implement → review → refine → PR with optional GitHub-webhook re-triggering on PR comments.

## Architecture at a glance

```
┌──────────────────────────────────────────────────────────────────┐
│                          Frontend                                 │
│                React 18 + Vite + Tailwind + CodeMirror            │
│                                                                   │
│  Dashboard ──► Board (Kanban) ──► Task Detail ──► Chat            │
│  (projects)    (3 columns)        (docs + convos)  (messages)     │
└──────────────────────────────────────────────────────────────────┘
                      │ REST (/api/*)          │ WebSocket (/?token=)
                      ▼                        ▼
┌──────────────────────────────────────────────────────────────────┐
│                          Backend                                  │
│              Node.js + Express + ws + better-sqlite3              │
│                                                                   │
│  routes/*  ──►  services/conversation/* (lifecycle)               │
│                 services/agentRunner.ts   (agent loop)            │
│                 services/worktree.ts      (git worktrees)         │
│                 services/sqliteSessionStore.ts (transcripts)      │
│                 services/claudeCredentials.ts  (per-user OAuth)   │
└──────────────────────────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────────────────┐
│  Claude Agent SDK (one subprocess per query)                      │
│  SQLite (server/database/bottega.db)                              │
│     ├─ Domain tables: users, projects, project_members, tasks,    │
│     │  conversations, task_agent_runs, app_settings,              │
│     │  user_agent_model_settings (per-user agent provider/model)  │
│     └─ Session tables: messages, session_summaries (the SDK's     │
│        sessionStore backend — single source of truth for          │
│        conversation transcripts)                                  │
│  Filesystem:                                                      │
│     ~/.bottega/projects/{id}/tasks/task-{id}.md (task docs)       │
│     ~/.bottega/prompts/*.md                    (user prompt       │
│                                                 overrides)        │
│     ~/.config/bottega/users/{userId}/oauth_token (Claude OAuth)   │
│     {repo}-worktrees/task-{id}/                 (per-task git     │
│                                                  worktree)        │
└──────────────────────────────────────────────────────────────────┘
```

## Documentation index

This directory is organized by architectural concern. Pull whichever file matches the work you're doing — don't load the whole set unless you need to.

| Doc | When to read |
|---|---|
| **[`claude-sdk-integration.md`](./claude-sdk-integration.md)** | Anything touching the Claude Agent SDK: transcript storage, per-user OAuth, `query()` options, the `AskUserQuestion` tool, the stale-subprocess 401 recovery. |
| **[`opencode-sdk-integration.md`](./opencode-sdk-integration.md)** | Anything touching OpenCode: Zen auth, per-user `opencode serve` pool, session model, event mapping, REST routes. |
| **[`conversation-management.md`](./conversation-management.md)** | Conversation lifecycle (start / resume / abort), WebSocket streaming, history loading, context-usage, title generation, slash commands, file attachments, voice input, the chat UI. |
| **[`agentic-loop.md`](./agentic-loop.md)** | The six agent types, the auto-chaining state machine, YOLO mode, prompt templates + user overrides, per-agent model+effort, git worktrees, GitHub webhook callbacks. |
| **[`task-management.md`](./task-management.md)** | The domain model (projects / tasks / conversations), the SQLite schema, `TaskContext` state + navigation, URL routing, the 4-screen UI flow. |
| **[`authentication.md`](./authentication.md)** | App-level auth (JWT + per-user API keys, NOT Claude OAuth), `token_version` invalidation, rate limiting, the project-membership authorization model, admin panel, `is_technical`. |
| **[`api-reference.md`](./api-reference.md)** | Flat lookup table of REST endpoints and WebSocket message types. Read the topical docs for the **why**; read this for the **shape**. |

## Tech stack

- **Frontend**: React 18, Vite, React Router, Tailwind CSS, CodeMirror.
- **Backend**: Node.js (`tsx` for dev), Express, `ws`, `better-sqlite3`, `node-pty` (for the Claude login PTY), `bcrypt`, `jsonwebtoken`.
- **External APIs**: Anthropic via the `@anthropic-ai/claude-agent-sdk`; OpenAI `gpt-4o-transcribe` for voice input.
- **TypeScript-only.** Every source file is `.ts`/`.tsx`. `tsconfig.json` sets `allowJs: false` and a `pnpm guard-no-js` prelint hook fails CI on any new `.js`/`.jsx` outside `node_modules`/`dist`/`coverage`.

## Repository layout

```
server/             Backend
  index.ts          Express + WS bootstrap, route mounting
  cli.ts            Dev launcher (pnpm dev)
  database/         SQLite schema + query helpers
  middleware/       auth, validate, upload
  routes/           HTTP route handlers (one file per resource)
  services/         Domain logic
    conversation/   Conversation lifecycle (orchestrators, streaming loop, hooks)
    sqliteSessionStore.ts  Claude SDK sessionStore backend
    claudeCredentials.ts   Per-user OAuth tokens
    agentRunner.ts         Agent run orchestration
    worktree.ts            Git worktree primitives
    promptRenderer.ts      Prompt template engine
  constants/
    prompts/        Default markdown prompt templates per agent type
    templates/      Reusable template fragments
  websocket/        Dispatch + broadcast helpers

src/                Frontend
  App.tsx           React Router routes + provider stack
  contexts/         TaskContext, AuthContext, WebSocketContext, …
  hooks/            useTasksLiveSubscriptions, useSessionStreaming, useSlashCommands, useAuthToken
  pages/            One file per route — thin wrappers that bind URL params to TaskContext
  components/       UI: Dashboard, BoardView, TaskDetailView, ChatInterface, AskUserQuestion, AgentSection, Admin/*

shared/             Shared frontend/backend types
  schemas/          zod validators (input boundary)
  api/              Typed REST request/response contracts
  websocket/        Typed WebSocket message union
  types/            DB row types, agent model settings
  sdk/              Re-exports from @anthropic-ai/claude-agent-sdk

scripts/
  complete-workflow.ts   Set workflow_complete=1 (agents run this)
  complete-pr.ts         Set pr_agent_complete=1 (agents run this)
  data-migrations/       One-shot scripts (e.g. import-jsonl-to-sqlite.ts)
  guard-no-js.ts         CI prelint: rejects .js files outside the allowlist

docs/               You are here.
```

## Running locally

```bash
corepack enable          # provisions pnpm at the version pinned in package.json
pnpm install
pnpm dev                 # frontend on :5173, backend on :3002
pnpm test:run            # unit + integration tests (Vitest)
```

`JWT_SECRET` is required in `.env` (`openssl rand -hex 64`). `OPENAI_API_KEY` is needed if you want voice input. `GITHUB_WEBHOOK_SECRET` is needed for the PR-comment trigger. Per-user Claude OAuth tokens are provisioned through the in-app login flow (Settings → Connect Claude) — see [`claude-sdk-integration.md`](./claude-sdk-integration.md#authentication-claude-subscription-oauth).
