import { describe, expect, it } from 'vitest';
import {
  QA_CSV_HEADER,
  countQaProgress,
  parseQaScenarios,
  serializeQaScenarios,
  type QaScenarioRow,
} from './qa.js';

const row = (overrides: Partial<QaScenarioRow> = {}): QaScenarioRow => ({
  id: 'S-001',
  feature: 'Login',
  title: 'Wrong password shows an error',
  steps: '1. Open /login\n2. Submit a wrong password',
  expected: 'The form shows "Invalid credentials", stays on /login',
  status: '',
  confidence: '',
  notes: '',
  ...overrides,
});

describe('serializeQaScenarios / parseQaScenarios', () => {
  it('round-trips rows whose cells carry commas, quotes and newlines', () => {
    const rows = [
      row(),
      row({
        id: 'S-002',
        status: 'fail',
        confidence: '1',
        notes: 'expected "OK", observed:\nnothing',
      }),
    ];
    const parsed = parseQaScenarios(serializeQaScenarios(rows));
    expect(parsed).toEqual({ ok: true, rows });
  });

  it('skips blank lines between rows', () => {
    const text = serializeQaScenarios([row()]) + '\n\n';
    const parsed = parseQaScenarios(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rows).toHaveLength(1);
  });

  it('rejects a wrong header naming both shapes', () => {
    const parsed = parseQaScenarios('id,feature,status\nS-001,Login,pass\n');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors[0]).toContain(QA_CSV_HEADER.join(','));
  });

  it('collects every row problem instead of stopping at the first', () => {
    const text = serializeQaScenarios([
      row({ id: 'BAD-1' }),
      row({ id: 'S-002' }),
      row({ id: 'S-002' }),
    ]);
    const parsed = parseQaScenarios(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.some((e) => e.includes('invalid id "BAD-1"'))).toBe(true);
      expect(parsed.errors.some((e) => e.includes('duplicate id "S-002"'))).toBe(true);
    }
  });

  it('rejects invalid status and confidence values', () => {
    const badStatus =
      QA_CSV_HEADER.join(',') + '\n' + 'S-001,Login,Title,Steps,Expected,maybe,3,\n';
    const badConfidence =
      QA_CSV_HEADER.join(',') + '\n' + 'S-001,Login,Title,Steps,Expected,pass,5,\n';
    const statusParsed = parseQaScenarios(badStatus);
    expect(statusParsed.ok).toBe(false);
    if (!statusParsed.ok) {
      expect(statusParsed.errors.some((e) => e.includes('invalid status "maybe"'))).toBe(true);
    }
    const confidenceParsed = parseQaScenarios(badConfidence);
    expect(confidenceParsed.ok).toBe(false);
    if (!confidenceParsed.ok) {
      expect(confidenceParsed.errors.some((e) => e.includes('invalid confidence "5"'))).toBe(true);
    }
  });

  it('rejects a row with the wrong cell count', () => {
    const text = QA_CSV_HEADER.join(',') + '\nS-001,Login,Title\n';
    const parsed = parseQaScenarios(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors[0]).toContain('expected 8 cells, got 3');
  });

  it('reports an unparseable file as one error', () => {
    const parsed = parseQaScenarios(QA_CSV_HEADER.join(',') + '\nS-001,"unterminated\n');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors[0]).toContain('Unterminated quoted cell');
  });
});

describe('countQaProgress', () => {
  it('tallies pass, fail and not-run', () => {
    const rows = [
      row({ id: 'S-001', status: 'pass', confidence: '3' }),
      row({ id: 'S-002', status: 'fail', confidence: '2' }),
      row({ id: 'S-003' }),
      row({ id: 'S-004', status: 'pass', confidence: '1' }),
    ];
    expect(countQaProgress(rows)).toEqual({ total: 4, pass: 2, fail: 1, notRun: 1 });
  });

  it('reports an empty book as fully run', () => {
    expect(countQaProgress([])).toEqual({ total: 0, pass: 0, fail: 0, notRun: 0 });
  });
});
