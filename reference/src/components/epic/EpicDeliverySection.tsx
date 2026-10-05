/**
 * EpicDeliverySection — the epic's final pull request, and the conversations
 * that land it.
 *
 * Delivery is deliberately NOT a pipeline stage: it has no flag, signs nothing
 * off, gates nothing, and is not a row in `EpicStageRail`. What it is is the
 * one place that owns the last mile — the pull request from the epic's feature
 * branch into the default branch, plus every conversation about it.
 *
 * Two things start those conversations and both land here, which is the whole
 * point of one list:
 *   - the user, from the "New conversation" button (a merge conflict to
 *     resolve, a question about what the epic delivered);
 *   - GitHub, when someone @-mentions the instance's trigger on the final pull
 *     request — the webhook route starts an `epic-delivery` run exactly as a
 *     comment on a ticket PR starts that ticket's `pr` agent
 *     (`server/routes/webhooks.ts`).
 *
 * Before this section a webhook comment on the final pull request was silently
 * ignored (its branch matches no `task/…` pattern) and a manual epic chat had
 * no entry point and no way back to it. Newest first, so whatever just
 * happened is at the top.
 *
 * "Open final PR" lives here rather than in the orchestration header: opening
 * the epic's own pull request is not an orchestration step, and folding it into
 * that state machine made Start/Pause/Resume/Open-PR read as one sequence.
 *
 * **Switch Server** lives here for the same reason it lives on the task page:
 * it previews what this surface owns. For a ticket that is its branch; for an
 * epic it is the feature branch — the only place every merged ticket exists
 * together, since each ticket's worktree is deleted when it merges. Same
 * symlink, same endpoint, same green "Active Server" affordance
 * (`ServeSwitchButton`); only the target differs.
 */

import { GitPullRequest, MessageSquare, Plus } from 'lucide-react';
import { Button } from '../ui/button';
import ServeSwitchButton from '../ServeSwitchButton';
import EpicStageStatusBadge from './EpicStageStatusBadge';
import type { WebServerStatusSuccess } from '@shared/api/projects';
import type { ConversationRow, EpicAgentRunRow, EpicRow, TaskRow } from '@shared/types/db';

export interface EpicDeliverySectionProps {
  epic: EpicRow;
  tickets: TaskRow[];
  /** All the epic's agent runs — the delivery ones are filtered out here. */
  agentRuns: EpicAgentRunRow[];
  /** All the epic's conversations, for their names. */
  conversations: ConversationRow[];
  /** True while any epic agent is running: one conversation at a time. */
  isEpicBusy: boolean;
  isStartingConversation: boolean;
  isOpeningPR: boolean;
  onStartConversation: () => void;
  onOpenPR: () => void;
  onOpenConversation: (conversationId: number) => void;
  /** Null when the project has no serving symlink configured. */
  webServerStatus?: WebServerStatusSuccess | null;
  isSwitchingServer?: boolean;
  onSwitchServer?: () => void;
  onOpenApp?: () => void;
  onResetServer?: () => void;
}

/** Why the final pull request cannot be opened yet, or null when it can. */
function completionPRBlockedReason(tickets: TaskRow[]): string | null {
  if (!tickets.length) return 'This epic has no tickets.';
  const unmerged = tickets.filter((t) => t.status !== 'completed').length;
  return unmerged > 0
    ? `${unmerged} ticket${unmerged === 1 ? ' is' : 's are'} not merged yet.`
    : null;
}

function EpicDeliverySection({
  epic,
  tickets,
  agentRuns,
  conversations,
  isEpicBusy,
  isStartingConversation,
  isOpeningPR,
  onStartConversation,
  onOpenPR,
  onOpenConversation,
  webServerStatus = null,
  isSwitchingServer = false,
  onSwitchServer,
  onOpenApp,
  onResetServer,
}: EpicDeliverySectionProps) {
  // Newest first: a webhook comment that just arrived is what the user came to
  // look at. `ticket_task_id` is null on every delivery run — it is about the
  // epic's own pull request, not a ticket's.
  const deliveryRuns = agentRuns
    .filter((run) => run.agent_type === 'epic-delivery')
    .sort((a, b) => b.id - a.id);

  const conversationName = (conversationId: number): string | null =>
    conversations.find((c) => c.id === conversationId)?.name ?? null;

  const prBlockedReason = completionPRBlockedReason(tickets);
  // The branch is created with the epic's first ticket; without it there is
  // nothing to check out, and the server refuses the run for the same reason.
  const conversationBlockedReason = !epic.feature_branch
    ? 'This epic has no feature branch yet — create its first ticket.'
    : isEpicBusy
      ? 'Wait for the running conversation to finish first.'
      : null;

  return (
    <div className="rounded-md border border-border bg-card">
      <div className="border-b border-border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <GitPullRequest className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Final pull request</h3>

          <div className="flex-1" />

          {/* Preview the epic at the project's real URL. Same symlink, same
              endpoint as a ticket's — pointed at the feature branch, which is
              the only place every merged ticket exists together (each ticket's
              own worktree is deleted when it merges). */}
          {webServerStatus?.isConfigured && onSwitchServer && onOpenApp && onResetServer ? (
            <ServeSwitchButton
              isActive={webServerStatus.activeEpicId === epic.id}
              isSwitching={isSwitchingServer}
              onSwitch={onSwitchServer}
              onOpenApp={onOpenApp}
              onReset={onResetServer}
              disabledReason={
                epic.feature_branch
                  ? null
                  : 'This epic has no feature branch yet — create its first ticket.'
              }
              switchTitle="Serve this epic's feature branch — every merged ticket together — at the project URL"
              activeTitle="This epic is the active server — click to open the app"
            />
          ) : null}

          <Button
            variant="outline"
            size="sm"
            onClick={onStartConversation}
            disabled={isStartingConversation || conversationBlockedReason !== null}
            title={
              conversationBlockedReason ??
              'Talk to an agent about this pull request — resolve conflicts, answer a review, or ask what the epic delivered'
            }
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {isStartingConversation ? 'Starting…' : 'New conversation'}
          </Button>

          <Button
            size="sm"
            onClick={onOpenPR}
            disabled={isOpeningPR || prBlockedReason !== null}
            title={
              prBlockedReason ?? 'Open or view the final pull request from the epic feature branch'
            }
          >
            <GitPullRequest className="mr-1.5 h-4 w-4" />
            {isOpeningPR ? 'Opening…' : 'Open final PR'}
          </Button>
        </div>

        <p className="mt-2 text-sm text-muted-foreground">
          {prBlockedReason
            ? 'One pull request merges the whole epic, from its feature branch into the default branch — it opens once every ticket is merged.'
            : 'Every ticket is merged. One pull request takes the epic home; you merge it, no agent does.'}{' '}
          A conversation here works in the epic&apos;s own worktree, so it can resolve conflicts on
          the feature branch without touching your checkout. Mentioning the instance on the pull
          request on GitHub starts one too.
        </p>
      </div>

      <div className="p-4">
        {deliveryRuns.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No delivery conversation yet.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {deliveryRuns.map((run, index) => (
              <li
                key={run.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border bg-card p-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm">
                    {(run.conversation_id != null ? conversationName(run.conversation_id) : null) ??
                      `Delivery conversation #${deliveryRuns.length - index}`}
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
        )}
      </div>
    </div>
  );
}

export default EpicDeliverySection;
