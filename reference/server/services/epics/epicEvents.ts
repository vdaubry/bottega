// The epic channel's row payload, in one place.
//
// Three callers announce the same thing — "the epic row changed": the
// `mark_stage_complete` tool, the REST routes (PATCH, the stage backstop, the
// orchestrator endpoints) and the orchestrator's own tools. They must all send the identical field set, or an
// open epic page renders a half-updated row depending on who moved it.
//
// A leaf on purpose: it takes the broadcaster as an argument rather than
// reaching for `app.locals`, so tools, hooks and routes can all use it.

import type { EpicRow } from '@shared/types/db';
import type { BroadcastToEpicSubscribersFn, EpicSummary } from '@shared/websocket/messages';

/** The `epic-updated` payload for a row: lifecycle + stage flags + orchestration. */
export function toEpicSummary(epic: EpicRow): EpicSummary {
  return {
    id: epic.id,
    status: epic.status,
    architecture_complete: epic.architecture_complete,
    specs_complete: epic.specs_complete,
    stories_complete: epic.stories_complete,
    review_complete: epic.review_complete,
    qa_complete: epic.qa_complete,
    orchestration_active: epic.orchestration_active,
    orchestration_blocked: epic.orchestration_blocked,
    orchestration_blocked_reason: epic.orchestration_blocked_reason,
  };
}

/** Fan `epic-updated` out to the epic's subscribers. No-op without a broadcaster. */
export function broadcastEpicUpdated(
  broadcast: BroadcastToEpicSubscribersFn | undefined | null,
  epic: EpicRow,
): void {
  broadcast?.(epic.id, { type: 'epic-updated', epic: toEpicSummary(epic) });
}
