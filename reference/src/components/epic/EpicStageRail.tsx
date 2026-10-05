/**
 * EpicStageRail — the epic's framing as four rows: Architecture → Technical
 * specification → Stories → Specification review. These are the conversations
 * that prepare the work; the implementation stage that consumes their output
 * lives in `EpicImplementationSection`, attached to the tickets it drives.
 *
 * Two independent facts are shown per stage, and conflating them would hide the
 * interesting cases. The **status chip** comes from the stage's latest agent run
 * (highest id — the same rule the task AgentSection uses): it says what the
 * machinery last did. The **signed-off mark** comes from the epic row's stage
 * flag: it says the user approved the result. A stage can be signed off with no
 * run (the backstop button below, or a flag set before this page existed), and
 * a stage can have a completed run that nobody approved — the normal state
 * while the user is still reading the output.
 *
 * The gates repeated here mirror `checkStageGate` in `server/routes/epics.ts`,
 * which stays authoritative: this only decides whether to offer the button, and
 * a start the server refuses surfaces its 409 as an error on the page.
 */

import { useState } from 'react';
import { CheckCircle2, ChevronRight, MessageSquare, Play, RefreshCw } from 'lucide-react';
import EpicStageStatusBadge, { type EpicStageStatus } from './EpicStageStatusBadge';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import type { EpicStageName } from '@shared/schemas/epics';
import type { EpicAgentType } from '@shared/websocket/messages';
import type { EpicAgentRunRow, ConversationRow, EpicRow } from '@shared/types/db';

interface StageDef {
  agentType: EpicAgentType;
  /** The stage flag this row signs off with. */
  stage: EpicStageName;
  label: string;
  description: string;
}

export const EPIC_STAGES: StageDef[] = [
  {
    agentType: 'epic-architecture',
    stage: 'architecture',
    label: 'Architecture',
    description:
      'Reads the functional spec, explores the repo and writes the architecture document — the epic split into topics, each with its decisions and diagrams — into the epic archive. Refine it by replying in its conversation; it signs the stage off once you approve.',
  },
  {
    agentType: 'epic-specification',
    stage: 'specification',
    label: 'Technical specification',
    description:
      'Interrogates you about everything the functional spec leaves open, then writes the specification documents. It signs the stage off once you approve.',
  },
  {
    agentType: 'epic-stories',
    stage: 'stories',
    label: 'Stories',
    description:
      "Agrees the ticket split with you in chat, then creates the epic's tickets on its feature branch, in execution order.",
  },
  {
    agentType: 'epic-spec-review',
    stage: 'review',
    label: 'Specification review',
    description:
      'The final gate before autonomous implementation: reads the functional spec, the architecture document, the technical specification and every ticket, checks them against each other and against the code, and writes a report. Discuss its findings in its conversation — it applies the ones you approve to the documents and tickets itself — and it signs the stage off once you give the go-ahead.',
  },
];

/** Whether the epic row says this stage was signed off. */
export function isStageSignedOff(epic: EpicRow, stage: EpicStageName): boolean {
  switch (stage) {
    case 'architecture':
      return !!epic.architecture_complete;
    case 'specification':
      return !!epic.specs_complete;
    case 'stories':
      return !!epic.stories_complete;
    case 'review':
      return !!epic.review_complete;
    case 'implementation':
      // No flag: the orchestrator has no single approval moment. The stage is
      // done when every ticket has merged, which only the ticket rows know —
      // `orchestrationStatus` reads them, and the implementation section uses
      // that instead.
      return false;
    case 'qa':
      return !!epic.qa_complete;
  }
}

/** Why this stage cannot be started yet, or null when it can. */
export function stageBlockedReason(epic: EpicRow, stage: EpicStageName): string | null {
  switch (stage) {
    case 'architecture':
      return null;
    case 'specification':
      return epic.architecture_complete ? null : 'Run the architecture stage first';
    case 'stories':
      return epic.specs_complete ? null : 'Complete the technical specification first';
    case 'review':
      return epic.stories_complete ? null : 'Create and approve the epic tickets first';
    case 'implementation':
      return epic.review_complete ? null : 'Finish the specification review first';
    case 'qa':
      // The scenario book derives from the documents, so it needs the review
      // to have finalized them — the same gate the server enforces.
      return epic.review_complete ? null : 'Finish the specification review first';
  }
}

/** Latest run wins — highest id, the same rule the task AgentSection uses. */
export function latestRun(runs: EpicAgentRunRow[], agentType: string): EpicAgentRunRow | null {
  return runs.filter((run) => run.agent_type === agentType).sort((a, b) => b.id - a.id)[0] ?? null;
}

export interface EpicStageRailProps {
  epic: EpicRow;
  agentRuns: EpicAgentRunRow[];
  conversations: ConversationRow[];
  /** True while ANY stage of this epic is running: one stage at a time. */
  isEpicBusy: boolean;
  startingStage: EpicAgentType | null;
  markingStage: EpicStageName | null;
  onStart: (agentType: EpicAgentType) => void;
  onOpenConversation: (conversationId: number) => void;
  onMarkComplete: (stage: EpicStageName) => void;
}

function StageRow({
  def,
  epic,
  agentRuns,
  conversations,
  isEpicBusy,
  startingStage,
  markingStage,
  onStart,
  onOpenConversation,
  onMarkComplete,
}: EpicStageRailProps & { def: StageDef }) {
  const [showConversations, setShowConversations] = useState(false);

  const run = latestRun(agentRuns, def.agentType);
  const status: EpicStageStatus = run ? run.status : 'not_started';
  const signedOff = isStageSignedOff(epic, def.stage);
  const blockedReason = stageBlockedReason(epic, def.stage);
  const isStarting = startingStage === def.agentType;

  const stageRuns = agentRuns.filter((r) => r.agent_type === def.agentType);
  const stageConversationIds = new Set(
    stageRuns.map((r) => r.conversation_id).filter((id): id is number => id != null),
  );
  const stageConversations = conversations.filter((c) => stageConversationIds.has(c.id));

  return (
    <li className="border-b border-border last:border-b-0">
      <div className="p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">{def.label}</h3>
          <EpicStageStatusBadge status={status} />
          {signedOff ? (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400"
              title="Approved by you — the next stage is unblocked"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              Signed off
            </span>
          ) : null}

          <div className="flex-1" />

          {run?.conversation_id ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenConversation(run.conversation_id!)}
            >
              <MessageSquare className="mr-1.5 h-4 w-4" />
              Open conversation
            </Button>
          ) : null}

          {!signedOff ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onMarkComplete(def.stage)}
              disabled={markingStage === def.stage}
              title="Record this stage as approved without asking its agent to do it"
            >
              <CheckCircle2 className="mr-1.5 h-4 w-4" />
              {markingStage === def.stage ? 'Marking…' : 'Mark complete'}
            </Button>
          ) : null}

          <Button
            size="sm"
            onClick={() => onStart(def.agentType)}
            disabled={isStarting || isEpicBusy || blockedReason !== null}
            title={blockedReason ?? undefined}
          >
            {run ? <RefreshCw className="mr-1.5 h-4 w-4" /> : <Play className="mr-1.5 h-4 w-4" />}
            {isStarting ? 'Starting…' : run ? 'Run again' : 'Start'}
          </Button>
        </div>

        <p className="text-sm text-muted-foreground">{def.description}</p>

        {blockedReason ? (
          <p className="mt-2 text-xs text-muted-foreground">{blockedReason}.</p>
        ) : null}

        {stageConversations.length > 0 ? (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setShowConversations((v) => !v)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ChevronRight
                className={cn('h-3.5 w-3.5 transition-transform', showConversations && 'rotate-90')}
              />
              {stageConversations.length} conversation
              {stageConversations.length === 1 ? '' : 's'}
            </button>
            {showConversations ? (
              <ul className="mt-1 space-y-1 pl-5">
                {stageConversations.map((conversation) => (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      onClick={() => onOpenConversation(conversation.id)}
                      className="truncate text-xs text-muted-foreground hover:text-foreground hover:underline"
                    >
                      {conversation.name || `Conversation #${conversation.id}`}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function EpicStageRail(props: EpicStageRailProps) {
  return (
    <ul className="rounded-md border border-border bg-card">
      {EPIC_STAGES.map((def) => (
        <StageRow key={def.agentType} def={def} {...props} />
      ))}
    </ul>
  );
}

export default EpicStageRail;
