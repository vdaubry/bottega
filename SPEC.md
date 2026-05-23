# Bottega — Specification

Bottega orchestrates a small team of coding agents that collaborate on a single
task. You describe the work in a markdown file; a chain of agents plans it,
implements it, reviews it, and opens a pull request — iterating on their own
until the work is done or they hit something only you can resolve.

This repository is **spec-first**. The specification *is* the product. A
complete, working implementation lives under [`reference/`](./reference) — read
it freely — but the goal is to let you (or a coding agent) **rebuild the tool
from this spec**, keeping the parts you want and swapping the opinionated parts
for your own.

## How to build from this spec

Point a coding agent at this file and say "build this." Then:

1. Read this file top to bottom.
2. Implement everything in [`core/`](./core). That is the whole product at its
   smallest. The core docs are written as **behavior** — what the tool does and
   why — with technical guidance and pointers into `reference/` for the parts
   that were genuinely hard to get right.
3. Implement whichever [`extra/`](./extra) features you want. These are
   **opinionated**: they reflect one company's preferences, not universal
   truths. Skip any of them and core still works.

`reference/` is a citation, not a copy target. When a spec says "see
`reference/server/services/agentRunner.ts`," open it to learn *how* a problem
was solved, then implement it your way. The spec is the source of truth; where
the two disagree, the spec wins.

## The core value proposition

One thing, done well: **orchestrate multiple agents collaborating on one task
that is defined by a markdown file.**

```
planning ──▶ ( implementation ⇄ review ) ──▶ pull request
```

The tool does not care how the markdown file came to exist. We happen to ship a
Kanban board for authoring tasks, but you might wire tasks to Jira, Notion, or a
plain file in a repo. That is exactly why the board is an *extra*, not core.

## Design philosophy: small and simple

Bottega is meant to stay small. The core is a tight orchestration engine and
nothing more. If your team needs something different — another harness, another
agent role, a different task source — you **fork the behavior into your own
extra**; you don't grow the core.

This is a deliberate stance, and it shapes the spec:

- **Core is universal.** Every Bottega deployment has it.
- **Extra is preference.** Pick a subset; ignore the rest.
- We would rather you build your own extra than ask the core to absorb your
  workflow.

## Core specifications — `core/`

Implement all of these for a minimal working tool. Read them in this order.

| Spec | What it covers |
|---|---|
| [`core/orchestration-loop.md`](./core/orchestration-loop.md) | **The engine.** The state machine that drives plan → (implement ⇄ review) → PR: agent runs, chaining, the iteration cap, blocking, and how each step decides the next. Start here. |
| [`core/task-and-workspace.md`](./core/task-and-workspace.md) | The unit of work: a markdown document plus an isolated git worktree. Lifecycle, and where the doc lives so it survives the PR merge. Deliberately silent on how the doc is authored. |
| [`core/harness-contract.md`](./core/harness-contract.md) | The seam that makes "build your own" possible: the provider interface every coding harness must satisfy (start a turn, stream events, resume, load transcript, abort), plus the streaming runtime and the unified transcript stored as the single source of truth. |
| [`core/planning-agent.md`](./core/planning-agent.md) | The agent that turns a prompt + task doc into a structured implementation plan written back into the doc. |
| [`core/execution-loop.md`](./core/execution-loop.md) | The implementation agent and the thread-review agent, and how they alternate until the work passes review. |
| [`core/pull-request-agent.md`](./core/pull-request-agent.md) | The terminal agent: open the PR, drive CI to green, resolve conflicts, and signal completion. |

## Optional specifications — `extra/`

Opinionated features. Each is independent; implement what you want.

| Spec | What it adds |
|---|---|
| [`extra/harnesses/overview.md`](./extra/harnesses/overview.md) | Shared patterns for implementing the core harness contract against a real tool: event mapping, transcript mirroring, credential storage, subprocess lifecycle, the capability matrix. |
| [`extra/harnesses/claude-code.md`](./extra/harnesses/claude-code.md) | Claude Agent SDK integration. |
| [`extra/harnesses/codex.md`](./extra/harnesses/codex.md) | OpenAI Codex integration. |
| [`extra/harnesses/opencode.md`](./extra/harnesses/opencode.md) | OpenCode integration. |
| [`extra/kanban-board.md`](./extra/kanban-board.md) | The opinionated projects/tasks board and 4-screen UI for authoring tasks. Swap for Jira/Notion/etc. |
| [`extra/refinement-agent.md`](./extra/refinement-agent.md) | An extra agent that polishes the work between review and PR. |
| [`extra/yolo-mode.md`](./extra/yolo-mode.md) | A single-agent alternative to the multi-step pipeline. |
| [`extra/pr-comment-retrigger.md`](./extra/pr-comment-retrigger.md) | Re-run the PR agent automatically when a PR receives review comments (GitHub webhook). |
| [`extra/prompt-and-model-customization.md`](./extra/prompt-and-model-customization.md) | Per-agent prompt overrides and per-user model/effort selection. |
| [`extra/auth-and-multi-user.md`](./extra/auth-and-multi-user.md) | Accounts, API keys, project membership, admin, and role-driven behavior (e.g. auto-advancing past the plan gate for non-technical users). |
| [`extra/chat-ux.md`](./extra/chat-ux.md) | Manual-chat conveniences: slash commands, file attachments, voice input, title generation, the context-usage meter. |

## The reference implementation

`reference/` is a complete, deployed implementation. Use it to resolve any
ambiguity left by the spec.

- **Stack as built:** TypeScript end to end. React 18 + Vite frontend; Node +
  Express + `ws` backend; SQLite (`better-sqlite3`) for all state, including
  conversation transcripts. You are not required to match this stack — the spec
  describes behavior — but the reference assumes it, so its citations are
  TypeScript.
- **Where to start reading:** [`reference/server/database/init.sql`](./reference/server/database/init.sql)
  (the whole data model in one file) and
  [`reference/docs/project.md`](./reference/docs/project.md) (an architecture
  tour).
- **Citations:** spec files link to specific files and, where it helps, methods
  or line ranges. Treat each as "here is how we solved it," not "copy this."

## Non-goals

- Supporting every coding harness, task source, or agent role in core. That is
  what `extra/` and forking are for.
- Backwards-compatibility shims, configuration for hypothetical needs, or
  opt-out flags. Keep the core small.
