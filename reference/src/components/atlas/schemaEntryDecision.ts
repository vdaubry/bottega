/**
 * The Explore (Schema tab) entry decision, extracted as a pure function so the
 * "show the existing plan vs. auto-generate it" branch is unit-testable without
 * a React harness.
 *
 * On entry the page lists the task's artifacts. If a `plan` artifact already
 * exists we load and show it (idempotent re-entry — no wasted Claude turn);
 * otherwise we kick off a `kind: 'plan'` generation and show a waiting
 * indicator.
 */

import type { ArtifactKind } from '../../../shared/types/atlas';

export type SchemaEntryDecision = { action: 'show'; kind: 'plan' } | { action: 'generate' };

/**
 * Decide what to do when the Schema tab opens, given the kinds the task already
 * has an artifact for. A pre-existing `plan` artifact is shown; anything else
 * (including a task that only has flowchart/architecture but no plan) triggers
 * a fresh plan generation.
 */
export function decideSchemaEntry(existingKinds: readonly ArtifactKind[]): SchemaEntryDecision {
  return existingKinds.includes('plan') ? { action: 'show', kind: 'plan' } : { action: 'generate' };
}
