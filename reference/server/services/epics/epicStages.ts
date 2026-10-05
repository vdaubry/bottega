// The epic pipeline's stage vocabulary, and how it maps onto the `epics` row.
//
// Two callers need the same mapping and must never disagree: the
// `mark_stage_complete` MCP tool (an agent signing off its own stage) and the
// human "Mark stage complete" backstop on the epic page. This module is the
// single definition, and it is a leaf — no service imports — so both can take
// it without dragging anything along.

import { EPIC_STAGE_NAMES, type EpicStageName } from '../../../shared/schemas/epics.js';
import type { EpicAgentType, EpicRow } from '../../../shared/types/db.js';
import type { EpicStageFlag } from '../../database/epics.js';

export { EPIC_STAGE_NAMES };
export type { EpicStageName };

/**
 * Which stage each agent type owns. An agent may only sign off its own stage:
 * a specification agent that marked 'stories' complete would skip a whole
 * pipeline step on the user's behalf.
 *
 * `null` means the agent belongs to no stage and can never sign anything off.
 * The map stays exhaustive over `EpicAgentType` on purpose — adding an agent
 * type must be a decision taken here, not a silent absence.
 */
export const STAGE_BY_AGENT_TYPE: Record<EpicAgentType, EpicStageName | null> = {
  'epic-architecture': 'architecture',
  'epic-specification': 'specification',
  'epic-stories': 'stories',
  'epic-spec-review': 'review',
  'epic-orchestrator': 'implementation',
  // The per-ticket PR reviewer is the implementation stage's second agent.
  'epic-pr-review': 'implementation',
  // Delivery is not a stage: it lands the final pull request, which the user
  // merges. There is no flag for it to set and no gate it opens.
  'epic-delivery': null,
  // The QA scenario writer owns the 'qa' stage: its sign-off is the user
  // approving the scenario book, which is what gates the executor.
  'epic-qa-scenarios': 'qa',
  // QA execution is not a stage, like delivery: any number of runs, no flag to
  // set and no gate it opens — the CSV's per-row results are its outcome.
  'epic-qa-execution': null,
  // The QA fix mission is not a stage either: any number of runs, and its
  // outcome is a merged fix PR plus the re-tested rows in the book.
  'epic-qa-fix': null,
};

/**
 * Stage → the `epics` flag column it flips. 'implementation' has no flag: the
 * orchestrator's completion semantics (Phase 7) live in its own columns and
 * tools, so neither `mark_stage_complete` (which neither the orchestrator nor
 * the PR reviewer is given) nor the human backstop route can "complete" it.
 */
export const FLAG_BY_STAGE: Record<EpicStageName, EpicStageFlag | null> = {
  architecture: 'architecture',
  specification: 'specs',
  stories: 'stories',
  review: 'review',
  implementation: null,
  qa: 'qa',
};

/** The `epics` column each flag reads back from. */
export const FLAG_COLUMN = {
  architecture: 'architecture_complete',
  specs: 'specs_complete',
  stories: 'stories_complete',
  review: 'review_complete',
  qa: 'qa_complete',
} as const satisfies Record<EpicStageFlag, keyof EpicRow>;

/** True when this stage's flag is already set on the row. */
export function isStageComplete(epic: EpicRow, stage: EpicStageName): boolean {
  const flag = FLAG_BY_STAGE[stage];
  return flag ? !!epic[FLAG_COLUMN[flag]] : false;
}
