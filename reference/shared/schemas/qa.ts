// The epic QA scenario contract — the ONE definition of `qa/scenarios.csv`.
//
// Three consumers, one source of truth: the bottega MCP QA tools (which own
// every write, so a malformed file is impossible rather than merely detected),
// the QA routes' tests, and the artifacts-tab table renderer. The scenario
// writer fills the descriptive columns; the executor fills the three result
// columns and touches nothing else.

import { CsvParseError, parseCsv, stringifyCsv } from '../utils/csv.js';

export const QA_SCENARIOS_FILENAME = 'scenarios.csv';

export const QA_CSV_HEADER = [
  'id',
  'feature',
  'title',
  'steps',
  'expected',
  'status',
  'confidence',
  'notes',
] as const;

// '' = not yet run. There is deliberately no 'blocked' — a scenario the
// executor cannot run stays not-run, with the reason in `notes`.
export const QA_STATUSES = ['pass', 'fail'] as const;
export type QaStatus = (typeof QA_STATUSES)[number];

// 1 = low (a judgment call — e.g. interpreting a screenshot for CSS
// alignment), 3 = high (a deterministic check — e.g. a form's error message
// asserted from the DOM). Stored as strings because CSV has no numbers.
export const QA_CONFIDENCES = ['1', '2', '3'] as const;
export type QaConfidence = (typeof QA_CONFIDENCES)[number];

// Stable scenario ids (`S-001`, `S-002`, …) — what `record_qa_results`
// addresses rows by, and what survives a revision upsert.
export const QA_SCENARIO_ID_PATTERN = /^S-\d{3,}$/;

export interface QaScenarioRow {
  id: string;
  feature: string;
  title: string;
  steps: string;
  expected: string;
  status: '' | QaStatus;
  confidence: '' | QaConfidence;
  notes: string;
}

export type ParseQaScenariosResult =
  | { ok: true; rows: QaScenarioRow[] }
  | { ok: false; errors: string[] };

export interface QaProgress {
  total: number;
  pass: number;
  fail: number;
  notRun: number;
}

/**
 * Tally the result column — the one definition of "how far execution is".
 * Read by the execution prompt's resume line and by the continuation loop,
 * which stops exactly when `notRun` reaches zero.
 */
export function countQaProgress(rows: readonly QaScenarioRow[]): QaProgress {
  const pass = rows.filter((r) => r.status === 'pass').length;
  const fail = rows.filter((r) => r.status === 'fail').length;
  return { total: rows.length, pass, fail, notRun: rows.length - pass - fail };
}

function isQaStatus(value: string): value is '' | QaStatus {
  return value === '' || (QA_STATUSES as readonly string[]).includes(value);
}

function isQaConfidence(value: string): value is '' | QaConfidence {
  return value === '' || (QA_CONFIDENCES as readonly string[]).includes(value);
}

/**
 * Parse and validate a scenarios CSV. Returns every problem found rather than
 * the first, so a caller can show the whole repair list at once. Blank lines
 * are skipped.
 */
export function parseQaScenarios(text: string): ParseQaScenariosResult {
  let raw: string[][];
  try {
    raw = parseCsv(text);
  } catch (error) {
    if (error instanceof CsvParseError) return { ok: false, errors: [error.message] };
    throw error;
  }

  const errors: string[] = [];
  if (raw.length === 0) return { ok: false, errors: ['Empty file — expected a header row'] };

  const header = raw[0]!;
  if (header.join(',') !== QA_CSV_HEADER.join(',')) {
    return {
      ok: false,
      errors: [
        `Invalid header — expected "${QA_CSV_HEADER.join(',')}", got "${header.join(',')}"`,
      ],
    };
  }

  const rows: QaScenarioRow[] = [];
  const seenIds = new Set<string>();
  for (let index = 1; index < raw.length; index++) {
    const cells = raw[index]!;
    // A blank line parses as a single empty cell — skip it.
    if (cells.length === 1 && cells[0] === '') continue;
    const rowLabel = `row ${index + 1}`;
    if (cells.length !== QA_CSV_HEADER.length) {
      errors.push(`${rowLabel}: expected ${QA_CSV_HEADER.length} cells, got ${cells.length}`);
      continue;
    }
    const [id, feature, title, steps, expected, status, confidence, notes] = cells as [
      string, string, string, string, string, string, string, string,
    ];
    if (!QA_SCENARIO_ID_PATTERN.test(id)) {
      errors.push(`${rowLabel}: invalid id "${id}" (expected S-001 style)`);
    } else if (seenIds.has(id)) {
      errors.push(`${rowLabel}: duplicate id "${id}"`);
    } else {
      seenIds.add(id);
    }
    if (!isQaStatus(status)) {
      errors.push(`${rowLabel}: invalid status "${status}" (expected pass, fail or empty)`);
      continue;
    }
    if (!isQaConfidence(confidence)) {
      errors.push(`${rowLabel}: invalid confidence "${confidence}" (expected 1, 2, 3 or empty)`);
      continue;
    }
    rows.push({ id, feature, title, steps, expected, status, confidence, notes });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, rows };
}

/** Serialize scenario rows (header included) — the only writer of the format. */
export function serializeQaScenarios(rows: readonly QaScenarioRow[]): string {
  return stringifyCsv([
    [...QA_CSV_HEADER],
    ...rows.map((r) => [r.id, r.feature, r.title, r.steps, r.expected, r.status, r.confidence, r.notes]),
  ]);
}
