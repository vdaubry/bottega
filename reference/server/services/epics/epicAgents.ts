// Session configuration shared by the epic pipeline's agents.

import type { EpicAgentType } from '@shared/types/db';

/**
 * The two document-writing stages — architecture and specification — inspect
 * the repository but write only through provider-neutral archive tools. Native
 * Write/Edit variants are denied for every harness; `write_epic_document` and
 * `edit_epic_document` enforce path confinement to the stage-owned archive
 * directory before touching disk. This is stronger than a prompt convention
 * and gives Claude, Codex and OpenCode the same boundary.
 *
 * Bash is ON. It was denied at first as a mutation risk in the real checkout,
 * but that bought nothing a task agent does not already have (a task agent's
 * shell is not confined to its worktree either) and it cost the one thing
 * these stages exist for: a specification agent could not read a pull
 * request, `git log`, `git blame` or another branch — and sub-agents inherit
 * the denial, so delegating did not help. The stage prompts carry the rule
 * instead: the shell reads (`git show <ref>:<path>`, `gh pr diff`), it never
 * changes the checkout's state. Residual risk accepted, as for every task
 * agent; `settingSources` still loads the target repo's own .claude config.
 */
const DOCUMENT_STAGE_DISALLOWED_TOOLS: string[] = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
];

export const EPIC_ARCHITECTURE_DISALLOWED_TOOLS = DOCUMENT_STAGE_DISALLOWED_TOOLS;
export const EPIC_SPECIFICATION_DISALLOWED_TOOLS = DOCUMENT_STAGE_DISALLOWED_TOOLS;

/**
 * The stories stage produces nothing on disk: tickets are created through the
 * `bottega` MCP tools, which do the same worktree/doc work the REST route does.
 * So every file-writing tool is denied outright — there is no legitimate write
 * for a gate to allow, and without a gate an un-denied Write would land in the
 * main checkout. Bash stays on for the same reason as the document stages
 * (sizing tickets against the real repo, read-only by prompt), and sub-agents
 * stay on so the agent can research in parallel.
 */
export const EPIC_STORIES_DISALLOWED_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/**
 * The specification reviewer is the gate between the tickets and autonomous
 * implementation — and the one agent that edits every document level. It
 * reads the functional specification, the architecture document, the
 * technical specification and every ticket, checks them against each other and
 * against the code, writes a report, then discusses it with the user and
 * applies the findings they approve: in `spec/`, `architecture/` and `docs/`
 * with its writers, in the tickets through the story tools. So it is a
 * document-writing stage like the two above — native writers denied, Bash on
 * for read-only verification, sub-agents on for parallel cross-checks — and
 * the portable document tools confine edits to the archive directories it
 * owns for the duration of the review.
 *
 * AskUserQuestion is on: the review is a conversation, not a verdict. A
 * contradiction between two approved documents is the user's to settle, and
 * the answer lands in the document the reviewer then edits — nothing is lost
 * to the transcript.
 */
export const EPIC_SPEC_REVIEW_DISALLOWED_TOOLS = DOCUMENT_STAGE_DISALLOWED_TOOLS;

/**
 * The orchestrator carries the full task-agent surface — nothing denied.
 *
 * It used to have no shell at all, on the reasoning that every change reaches
 * the repository through a ticket agent anyway. That reasoning held for
 * changes and broke for everything else: a ticket blocked on "this session has
 * no Playwright/browser connector" left the orchestrator unable to check
 * whether that was even true, let alone reinstall anything, so its only honest
 * move was to stop the epic and wake the user. Most blocks are like that —
 * an environment to repair, a service to probe, a claim to disprove — and the
 * delivery lead is exactly who should settle them.
 *
 * `AskUserQuestion` stays available (unlike `epic-pr-review`): it is the
 * orchestrator's escalation path for a decision only the user can take.
 *
 * What replaces the denials is prompt discipline, as with the document stages:
 * its cwd is the project's MAIN checkout, so the prompt forbids changing the
 * repository from here — writes belong to a ticket agent working in its own
 * worktree. Bash is for diagnosis and environment repair.
 */
export const EPIC_ORCHESTRATOR_DISALLOWED_TOOLS: string[] = [];

/**
 * The pull-request reviewer is the one epic agent that works INSIDE a ticket
 * worktree: it reviews the PR against the whole specification, fixes what it
 * finds itself, gets CI green and merges. So it carries the task-level PR
 * agent's full surface — Bash, every writer, sub-agents — and no write gate
 * (its cwd is the worktree; the epic archive is read-only to it by prompt).
 *
 * The one denial is AskUserQuestion. The reviewer is autonomous by design: the
 * specification is its source of truth and a human already approved the plan,
 * so there is no decision left for it to hand back — a question here would
 * park a subprocess for hours waiting on the user for something the
 * specification answers. The only exit it keeps is `block_epic`, for CI it
 * cannot get green.
 */
export const EPIC_PR_REVIEW_DISALLOWED_TOOLS = ['AskUserQuestion'];

/**
 * The delivery agent lands the epic's final pull request: merge the default
 * branch into the feature branch, resolve the conflicts, answer a GitHub
 * review comment, get CI green. So it carries the full task-agent surface —
 * Bash, every writer, sub-agents — like the PR reviewer, and for the same
 * reason: its cwd IS a git worktree of the branch it is changing (the epic's
 * delivery worktree, `{repo}-worktrees/epic-{id}`), so a write lands where it
 * belongs by construction rather than by instruction.
 *
 * `AskUserQuestion` stays available, unlike `epic-pr-review`. Delivery is not
 * autonomous work against an approved specification: half its runs ARE a
 * conversation the user opened, and the other half — a GitHub comment — is
 * feedback whose intent the person who wrote it may be the only one who knows.
 * A parked question is the right answer there; there is no ticket sequence
 * waiting on the turn.
 */
export const EPIC_DELIVERY_DISALLOWED_TOOLS: string[] = [];

/**
 * The QA scenario writer is a document-writing stage in every respect but the
 * format: it reads the whole epic (documents, tickets, repo) and writes one
 * CSV — through `write_qa_scenarios`/`delete_qa_scenarios`, whose handlers own
 * the serialization, so a malformed scenario file is impossible rather than
 * merely detected. Native writers denied like every document stage; Bash on
 * (read-only by prompt) for verifying what the UI actually offers; sub-agents
 * on for parallel coverage sweeps. AskUserQuestion stays on: the scenario book
 * is settled in conversation with the user, exactly like the review report.
 */
export const EPIC_QA_SCENARIOS_DISALLOWED_TOOLS = DOCUMENT_STAGE_DISALLOWED_TOOLS;

/**
 * The QA execution agent runs INSIDE the epic's delivery worktree — but unlike
 * delivery it must never change it: its job is to run the app and observe.
 * Native writers are denied; results are recorded through `record_qa_results`,
 * whose handler rewrites the CSV server-side. Bash stays on because the agent
 * starts and stops its own dev server (the prompt carries the no-mutation
 * rule, as everywhere else). AskUserQuestion stays on: an ambiguous scenario
 * is the user's to clarify, and nothing is sequenced behind the turn.
 */
export const EPIC_QA_EXECUTION_DISALLOWED_TOOLS = DOCUMENT_STAGE_DISALLOWED_TOOLS;

/**
 * The QA fix agent supervises one fix ticket end to end — create it from the
 * failed scenarios, drive its planification, review and merge its pull
 * request, then re-test — so it carries the PR reviewer's full surface: Bash,
 * every writer, sub-agents. Its cwd is the MAIN checkout for framing; the
 * prompt confines edits to the ticket's worktree and the delivery worktree to
 * `git pull --ff-only` + running the app.
 *
 * The one denial is AskUserQuestion, for the reviewer's reason: the mission is
 * autonomous against an approved specification and a filled scenario book, so
 * there is no decision left to hand back — `notify_user` is its one outward
 * channel.
 */
export const EPIC_QA_FIX_DISALLOWED_TOOLS = ['AskUserQuestion'];

/**
 * What each stage may not touch.
 */
export const EPIC_DISALLOWED_TOOLS_BY_STAGE: Record<EpicAgentType, string[]> = {
  'epic-architecture': EPIC_ARCHITECTURE_DISALLOWED_TOOLS,
  'epic-specification': EPIC_SPECIFICATION_DISALLOWED_TOOLS,
  'epic-stories': EPIC_STORIES_DISALLOWED_TOOLS,
  'epic-spec-review': EPIC_SPEC_REVIEW_DISALLOWED_TOOLS,
  'epic-orchestrator': EPIC_ORCHESTRATOR_DISALLOWED_TOOLS,
  'epic-pr-review': EPIC_PR_REVIEW_DISALLOWED_TOOLS,
  'epic-delivery': EPIC_DELIVERY_DISALLOWED_TOOLS,
  'epic-qa-scenarios': EPIC_QA_SCENARIOS_DISALLOWED_TOOLS,
  'epic-qa-execution': EPIC_QA_EXECUTION_DISALLOWED_TOOLS,
  'epic-qa-fix': EPIC_QA_FIX_DISALLOWED_TOOLS,
};
