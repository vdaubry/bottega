import { describe, it, expect } from 'vitest';
import { decideSchemaEntry } from './schemaEntryDecision';

describe('decideSchemaEntry', () => {
  it('generates when the task has no artifacts at all', () => {
    expect(decideSchemaEntry([])).toEqual({ action: 'generate' });
  });

  it('shows the existing plan artifact (idempotent re-entry, no regeneration)', () => {
    expect(decideSchemaEntry(['plan'])).toEqual({ action: 'show', kind: 'plan' });
    expect(decideSchemaEntry(['flowchart', 'plan', 'architecture'])).toEqual({
      action: 'show',
      kind: 'plan',
    });
  });

  it('generates a plan when only non-plan kinds exist', () => {
    expect(decideSchemaEntry(['flowchart'])).toEqual({ action: 'generate' });
    expect(decideSchemaEntry(['flowchart', 'architecture'])).toEqual({ action: 'generate' });
  });
});
