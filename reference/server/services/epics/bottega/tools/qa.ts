// The QA stage's tools — the ONLY writers of `qa/scenarios.csv`.
//
// The scenario writer and the execution agent never hand-edit CSV text: these
// handlers own parsing and serialization through `shared/schemas/qa`, so a
// syntactically malformed scenario file is impossible rather than merely
// detected — and the two downstream consumers (the executor and the artifacts
// tab's table) can hard-depend on parseability. `edit_epic_document`'s
// oldText-uniqueness contract is also actively hostile to a CSV of hundreds of
// near-identical rows, which is the independent reason the generic writers are
// withheld from both QA agents.

import fs from 'fs';
import { z } from 'zod';
import { definePortableTool as tool } from '../../../conversation/portableTool.js';
import { ensureEpicDirs, getEpicQaFilePath } from '../../epicArchive.js';
import {
  QA_SCENARIOS_FILENAME,
  QA_SCENARIO_ID_PATTERN,
  parseQaScenarios,
  serializeQaScenarios,
  type QaScenarioRow,
} from '@shared/schemas/qa';
import { ok, fail, errText } from '../toolResult.js';

export interface QaToolContext {
  projectId: number;
  epicId: number;
}

/** Parse the current book, or null when the file does not exist. */
function readBook(ctx: QaToolContext): { rows: QaScenarioRow[] } | { errors: string[] } | null {
  const filePath = getEpicQaFilePath(ctx.projectId, ctx.epicId, QA_SCENARIOS_FILENAME);
  if (!fs.existsSync(filePath)) return null;
  const parsed = parseQaScenarios(fs.readFileSync(filePath, 'utf8'));
  return parsed.ok ? { rows: parsed.rows } : { errors: parsed.errors };
}

/** Atomic replace, the archive-wide idiom (temp + rename). */
function writeBook(ctx: QaToolContext, rows: readonly QaScenarioRow[]): void {
  ensureEpicDirs(ctx.projectId, ctx.epicId);
  const filePath = getEpicQaFilePath(ctx.projectId, ctx.epicId, QA_SCENARIOS_FILENAME);
  const temporary = `${filePath}.bottega-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(temporary, serializeQaScenarios(rows), 'utf8');
  fs.renameSync(temporary, filePath);
}

const ScenarioInput = z.object({
  id: z.string().regex(QA_SCENARIO_ID_PATTERN, 'ids look like S-001'),
  feature: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(300),
  steps: z.string().trim().min(1).max(4000),
  expected: z.string().trim().min(1).max(2000),
});

/**
 * The scenario writer's catalog: write and delete scenarios by id. The three
 * result columns belong to the execution agent and are not writable here —
 * an upsert keeps whatever result a revised scenario already carried.
 */
export function buildQaScenarioTools(ctx: QaToolContext) {
  const writeScenarios = tool(
    'write_qa_scenarios',
    `Write QA scenarios into ${QA_SCENARIOS_FILENAME} (batches of up to 50). mode 'replace' discards the whole existing book, results included — use it only for the FIRST batch of a fresh write, then 'upsert' for every later batch. 'upsert' updates existing scenarios by id (their recorded results are kept) and appends new ids.`,
    {
      mode: z.enum(['replace', 'upsert']),
      scenarios: z.array(ScenarioInput).min(1).max(50),
    },
    async ({ mode, scenarios }) => {
      try {
        const batchIds = new Set<string>();
        for (const s of scenarios) {
          if (batchIds.has(s.id)) return fail(`Duplicate id in this batch: ${s.id}`);
          batchIds.add(s.id);
        }

        const current = readBook(ctx);
        if (mode === 'upsert' && current && 'errors' in current) {
          return fail(
            `${QA_SCENARIOS_FILENAME} does not parse (${current.errors[0]}) — rewrite it whole with mode 'replace'.`,
          );
        }

        const base = mode === 'replace' || current === null || 'errors' in current ? [] : current.rows;
        const byId = new Map(base.map((r) => [r.id, r]));
        let added = 0;
        let updated = 0;
        const next = [...base];
        for (const s of scenarios) {
          const existing = byId.get(s.id);
          if (existing) {
            existing.feature = s.feature;
            existing.title = s.title;
            existing.steps = s.steps;
            existing.expected = s.expected;
            updated++;
          } else {
            const row: QaScenarioRow = { ...s, status: '', confidence: '', notes: '' };
            next.push(row);
            byId.set(s.id, row);
            added++;
          }
        }
        writeBook(ctx, next);

        let warning = '';
        if (mode === 'replace' && current && 'rows' in current) {
          const dropped = current.rows.filter((r) => r.status !== '').length;
          if (dropped > 0) {
            warning = ` WARNING: the replace discarded ${dropped} scenario(s) that carried recorded results.`;
          }
        }
        return ok(
          `${QA_SCENARIOS_FILENAME} now holds ${next.length} scenario(s) (${added} added, ${updated} updated).${warning}`,
        );
      } catch (error) {
        return fail(errText(error));
      }
    },
  );

  const deleteScenarios = tool(
    'delete_qa_scenarios',
    'Delete scenarios from the book by id. Refuses unknown ids — nothing is deleted unless every id matches.',
    { ids: z.array(z.string().regex(QA_SCENARIO_ID_PATTERN)).min(1).max(100) },
    async ({ ids }) => {
      try {
        const current = readBook(ctx);
        if (current === null) return fail(`${QA_SCENARIOS_FILENAME} does not exist yet.`);
        if ('errors' in current) {
          return fail(
            `${QA_SCENARIOS_FILENAME} does not parse (${current.errors[0]}) — rewrite it whole with write_qa_scenarios mode 'replace'.`,
          );
        }
        const known = new Set(current.rows.map((r) => r.id));
        const unknown = ids.filter((id) => !known.has(id));
        if (unknown.length > 0) return fail(`Unknown id(s): ${unknown.join(', ')}. Nothing was deleted.`);
        const toDelete = new Set(ids);
        const next = current.rows.filter((r) => !toDelete.has(r.id));
        writeBook(ctx, next);
        return ok(`Deleted ${ids.length} scenario(s); ${next.length} remain.`);
      } catch (error) {
        return fail(errText(error));
      }
    },
  );

  return [writeScenarios, deleteScenarios];
}

/**
 * The execution agent's catalog: record results, and nothing else — it may not
 * add, remove or reword scenarios.
 */
export function buildQaExecutionTools(ctx: QaToolContext) {
  const recordResults = tool(
    'record_qa_results',
    'Record execution results for scenarios you have just run (batches of 1-20). Call this immediately after each scenario or small batch, so progress survives an interrupted turn. confidence: 3 = deterministic check, 2 = right behavior via an indirect signal, 1 = a judgment call. notes replaces the row\'s notes (required for fail: expected vs observed, repro detail).',
    {
      results: z
        .array(
          z.object({
            id: z.string().regex(QA_SCENARIO_ID_PATTERN),
            status: z.enum(['pass', 'fail']),
            confidence: z.union([z.literal(1), z.literal(2), z.literal(3)]),
            notes: z.string().max(2000).optional(),
          }),
        )
        .min(1)
        .max(20),
    },
    async ({ results }) => {
      try {
        const batchIds = new Set<string>();
        for (const r of results) {
          if (batchIds.has(r.id)) return fail(`Duplicate id in this batch: ${r.id}`);
          batchIds.add(r.id);
        }
        const current = readBook(ctx);
        if (current === null) return fail(`${QA_SCENARIOS_FILENAME} does not exist.`);
        if ('errors' in current) {
          return fail(
            `${QA_SCENARIOS_FILENAME} does not parse (${current.errors[0]}) — stop and report this; it must be fixed in the QA scenario stage.`,
          );
        }
        const byId = new Map(current.rows.map((r) => [r.id, r]));
        const unknown = results.filter((r) => !byId.has(r.id)).map((r) => r.id);
        if (unknown.length > 0) {
          return fail(`Unknown id(s): ${unknown.join(', ')}. Nothing was recorded — re-read the book.`);
        }
        for (const r of results) {
          const row = byId.get(r.id)!;
          row.status = r.status;
          row.confidence = String(r.confidence) as QaScenarioRow['confidence'];
          row.notes = r.notes ?? '';
        }
        writeBook(ctx, current.rows);
        const remaining = current.rows.filter((r) => r.status === '').length;
        return ok(
          `Recorded ${results.length} result(s). ${remaining} scenario(s) still not run.`,
        );
      } catch (error) {
        return fail(errText(error));
      }
    },
  );

  return [recordResults];
}
