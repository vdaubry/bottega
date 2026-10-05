/**
 * EpicQaSection — the QA step, fourth on the Main tab, after Delivery.
 *
 * Three agents, three subsections, mirroring the server exactly:
 *
 * - **Scenarios** is a gated stage (flag `qa_complete`): a writer agent reads
 *   the epic's documents and tickets and produces the scenario book
 *   (`qa/scenarios.csv`, read in the Artifacts tab), revises it from feedback
 *   in its conversation, and signs the stage off on the user's approval. The
 *   "Mark complete" backstop sets the flag by hand, like every stage's.
 * - **Execution** is delivery-style (no flag, any number of runs): it runs the
 *   approved book against the delivery worktree with the browser tools and
 *   fills the CSV's status/confidence/notes columns in place.
 * - **Fixes** is one autonomous mission per click: the agent turns the book's
 *   recorded failures into a fix ticket, drives it to a merged PR, then
 *   re-tests the failed scenarios and overwrites their rows.
 *
 * The gates repeated here mirror `checkStageGate` in `server/routes/epics.ts`,
 * which stays authoritative: this only decides whether to offer the button.
 */

import {
  CheckCircle2,
  ClipboardList,
  MessageSquare,
  Play,
  RefreshCw,
  Wrench,
} from 'lucide-react';
import { Button } from '../ui/button';
import EpicStageStatusBadge from './EpicStageStatusBadge';
import { latestRun } from './EpicStageRail';
import type { ConversationRow, EpicAgentRunRow, EpicRow, TaskRow } from '@shared/types/db';

export interface EpicQaSectionProps {
  epic: EpicRow;
  tickets: TaskRow[];
  /** All the epic's agent runs — the QA ones are filtered out here. */
  agentRuns: EpicAgentRunRow[];
  /** All the epic's conversations, for their names. */
  conversations: ConversationRow[];
  /** True while any epic agent is running: one conversation at a time. */
  isEpicBusy: boolean;
  isStartingScenarios: boolean;
  isStartingExecution: boolean;
  isStartingFixes: boolean;
  isMarkingComplete: boolean;
  /** Failed scenarios in the book, or null while the CSV is unknown/unparsed. */
  qaFailCount: number | null;
  onStartScenarios: () => void;
  onStartExecution: () => void;
  onStartFixes: () => void;
  /** The stage backstop: sets `qa_complete` by hand. */
  onMarkQaComplete: () => void;
  onOpenConversation: (conversationId: number) => void;
}

/** Why the scenario writer cannot start, or null — mirrors the server gate. */
function scenariosBlockedReason(epic: EpicRow, isEpicBusy: boolean): string | null {
  if (!epic.review_complete) return 'Finish the specification review first.';
  if (isEpicBusy) return 'Wait for the running conversation to finish first.';
  return null;
}

/** Why execution cannot start, or null — mirrors the server gate. */
function executionBlockedReason(
  epic: EpicRow,
  tickets: TaskRow[],
  isEpicBusy: boolean,
): string | null {
  if (!epic.qa_complete) return 'Write and approve the QA scenarios first.';
  if (!epic.feature_branch) {
    return 'This epic has no feature branch yet — create its first ticket.';
  }
  const unmerged = tickets.filter((t) => t.status !== 'completed').length;
  if (unmerged > 0) {
    return `${unmerged} ticket${unmerged === 1 ? ' is' : 's are'} not merged yet — QA runs the complete epic.`;
  }
  if (isEpicBusy) return 'Wait for the running conversation to finish first.';
  return null;
}

/** Why the fix mission cannot start, or null — mirrors the server gate. */
function fixesBlockedReason(
  epic: EpicRow,
  qaFailCount: number | null,
  isEpicBusy: boolean,
): string | null {
  if (!epic.feature_branch) {
    return 'This epic has no feature branch yet — create its first ticket.';
  }
  if (epic.orchestration_active) {
    return 'Orchestration is running — the fix mission can only start once it is finished.';
  }
  if (qaFailCount === null) return 'No parseable scenario book yet — run the QA stages first.';
  if (qaFailCount === 0) return 'The book records no failed scenario — nothing to fix.';
  if (isEpicBusy) return 'Wait for the running conversation to finish first.';
  return null;
}

function RunList({
  runs,
  conversations,
  fallbackLabel,
  onOpenConversation,
}: {
  runs: EpicAgentRunRow[];
  conversations: ConversationRow[];
  fallbackLabel: string;
  onOpenConversation: (conversationId: number) => void;
}) {
  if (runs.length === 0) return null;
  const conversationName = (conversationId: number): string | null =>
    conversations.find((c) => c.id === conversationId)?.name ?? null;
  return (
    <ul className="mt-2 space-y-1.5">
      {runs.map((run, index) => (
        <li
          key={run.id}
          className="flex items-center justify-between gap-2 rounded-md border border-border bg-card p-2"
        >
          <div className="flex min-w-0 items-center gap-2">
            <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm">
              {(run.conversation_id != null ? conversationName(run.conversation_id) : null) ??
                `${fallbackLabel} #${runs.length - index}`}
            </span>
            <EpicStageStatusBadge status={run.status} />
          </div>
          {run.conversation_id != null ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenConversation(run.conversation_id!)}
            >
              <MessageSquare className="mr-1.5 h-4 w-4" />
              Open
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function EpicQaSection({
  epic,
  tickets,
  agentRuns,
  conversations,
  isEpicBusy,
  isStartingScenarios,
  isStartingExecution,
  isStartingFixes,
  isMarkingComplete,
  qaFailCount,
  onStartScenarios,
  onStartExecution,
  onStartFixes,
  onMarkQaComplete,
  onOpenConversation,
}: EpicQaSectionProps) {
  const scenarioRuns = agentRuns
    .filter((run) => run.agent_type === 'epic-qa-scenarios')
    .sort((a, b) => b.id - a.id);
  const executionRuns = agentRuns
    .filter((run) => run.agent_type === 'epic-qa-execution')
    .sort((a, b) => b.id - a.id);
  const fixRuns = agentRuns
    .filter((run) => run.agent_type === 'epic-qa-fix')
    .sort((a, b) => b.id - a.id);
  const latestScenariosRun = latestRun(agentRuns, 'epic-qa-scenarios');

  const scenariosBlocked = scenariosBlockedReason(epic, isEpicBusy);
  const executionBlocked = executionBlockedReason(epic, tickets, isEpicBusy);
  const fixesBlocked = fixesBlockedReason(epic, qaFailCount, isEpicBusy);
  const scenariosStarted = scenarioRuns.length > 0;

  return (
    <div className="rounded-md border border-border bg-card">
      {/* Scenarios — the gated stage. */}
      <div className="border-b border-border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <ClipboardList className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">QA scenarios</h3>
          {latestScenariosRun ? <EpicStageStatusBadge status={latestScenariosRun.status} /> : null}
          {epic.qa_complete ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Approved
            </span>
          ) : null}

          <div className="flex-1" />

          {!epic.qa_complete && scenariosStarted ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onMarkQaComplete}
              disabled={isMarkingComplete}
              title="Backstop: set the QA flag by hand, without the agent's sign-off"
            >
              <CheckCircle2 className="mr-1.5 h-4 w-4" />
              {isMarkingComplete ? 'Marking…' : 'Mark complete'}
            </Button>
          ) : null}

          <Button
            size="sm"
            onClick={onStartScenarios}
            disabled={isStartingScenarios || scenariosBlocked !== null}
            title={
              scenariosBlocked ??
              'An agent reads the epic documents and tickets and writes the full scenario book (CSV) — review it in the Artifacts tab and give feedback in its conversation'
            }
          >
            {scenariosStarted ? (
              <RefreshCw className="mr-1.5 h-4 w-4" />
            ) : (
              <Play className="mr-1.5 h-4 w-4" />
            )}
            {isStartingScenarios ? 'Starting…' : scenariosStarted ? 'Run again' : 'Start'}
          </Button>
        </div>

        <p className="mt-2 text-sm text-muted-foreground">
          An agent derives every QA scenario — each button, form and state combination — from the
          epic&apos;s documents and tickets into one CSV, read and downloaded in the Artifacts tab.
          Refine it by replying in its conversation; it signs the stage off once you approve.
        </p>

        <RunList
          runs={scenarioRuns}
          conversations={conversations}
          fallbackLabel="Scenario conversation"
          onOpenConversation={onOpenConversation}
        />
      </div>

      {/* Execution — delivery-style, no flag. */}
      <div className="border-b border-border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Play className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">QA execution</h3>

          <div className="flex-1" />

          <Button
            size="sm"
            onClick={onStartExecution}
            disabled={isStartingExecution || executionBlocked !== null}
            title={
              executionBlocked ??
              'An agent starts a dev server from the epic worktree and runs the approved scenarios with the browser tools, recording pass/fail and confidence into the CSV; runs continue automatically until the book is filled'
            }
          >
            <Play className="mr-1.5 h-4 w-4" />
            {isStartingExecution ? 'Starting…' : 'Run QA'}
          </Button>
        </div>

        <p className="mt-2 text-sm text-muted-foreground">
          Runs the approved book against the epic&apos;s feature branch, in its own dev server, and
          fills in each scenario&apos;s pass/fail with a 1–3 confidence. Watch results land live in
          the Artifacts tab; runs continue automatically — each resuming at the first not-run
          scenario — until every scenario has a result, and stop with a notification if a run
          records nothing new.
        </p>

        <RunList
          runs={executionRuns}
          conversations={conversations}
          fallbackLabel="Execution run"
          onOpenConversation={onOpenConversation}
        />
      </div>

      {/* Fixes — one autonomous mission per click, no flag. */}
      <div className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Wrench className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">QA fixes</h3>

          <div className="flex-1" />

          <Button
            size="sm"
            onClick={onStartFixes}
            disabled={isStartingFixes || fixesBlocked !== null}
            title={
              fixesBlocked ??
              'One autonomous agent turns the recorded failures into a fix ticket on the feature branch, drives it through planning and implementation, reviews and merges its PR, then re-tests the failed scenarios and updates their rows'
            }
          >
            <Wrench className="mr-1.5 h-4 w-4" />
            {isStartingFixes
              ? 'Starting…'
              : `Fix failures${qaFailCount != null && qaFailCount > 0 ? ` (${qaFailCount})` : ''}`}
          </Button>
        </div>

        <p className="mt-2 text-sm text-muted-foreground">
          A single agent runs the whole repair: it writes one fix ticket from the failed
          scenarios&apos; recorded notes, answers the planner&apos;s questions from the epic
          documents, approves the plan, reviews and merges the resulting pull request into the
          feature branch, then re-runs exactly those scenarios and records what it observes. It
          notifies you at the end — or when it is stuck.
        </p>

        <RunList
          runs={fixRuns}
          conversations={conversations}
          fallbackLabel="Fix run"
          onOpenConversation={onOpenConversation}
        />
      </div>
    </div>
  );
}

export default EpicQaSection;
