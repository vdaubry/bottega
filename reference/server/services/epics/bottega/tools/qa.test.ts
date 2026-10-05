import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildQaScenarioTools, buildQaExecutionTools } from './qa.js';
import { QA_SCENARIOS_FILENAME, parseQaScenarios } from '@shared/schemas/qa';

const CTX = { projectId: 7, epicId: 42 };

function csvPath(archiveRoot: string): string {
  return path.join(archiveRoot, 'projects/7/epics/epic-42/qa', QA_SCENARIOS_FILENAME);
}

function readRows(archiveRoot: string) {
  const parsed = parseQaScenarios(fs.readFileSync(csvPath(archiveRoot), 'utf8'));
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.rows;
}

const scenario = (id: string, overrides: Record<string, string> = {}) => ({
  id,
  feature: 'Login',
  title: `Scenario ${id}`,
  steps: '1. Open /login\n2. Submit',
  expected: 'An error shows, with a comma, "quoted"',
  ...overrides,
});

describe('QA scenario tools (the writer)', () => {
  let archiveRoot: string;

  beforeEach(() => {
    archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-qa-tools-'));
    process.env.BOTTEGA_ARCHIVE_ROOT = archiveRoot;
  });

  afterEach(() => {
    delete process.env.BOTTEGA_ARCHIVE_ROOT;
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  });

  const tools = () => new Map(buildQaScenarioTools(CTX).map((t) => [t.name, t]));

  it('replace writes a fresh parseable book; upsert appends and updates by id', async () => {
    const byName = tools();
    const first = await byName.get('write_qa_scenarios')!.handler({
      mode: 'replace',
      scenarios: [scenario('S-001'), scenario('S-002')],
    });
    expect(first.isError).not.toBe(true);
    expect(first.content[0]!.text).toContain('2 scenario(s) (2 added, 0 updated)');

    const second = await byName.get('write_qa_scenarios')!.handler({
      mode: 'upsert',
      scenarios: [scenario('S-002', { title: 'Revised' }), scenario('S-003')],
    });
    expect(second.content[0]!.text).toContain('3 scenario(s) (1 added, 1 updated)');

    const rows = readRows(archiveRoot);
    expect(rows.map((r) => r.id)).toEqual(['S-001', 'S-002', 'S-003']);
    expect(rows[1]!.title).toBe('Revised');
    // Result columns are born empty and untouchable from this catalog.
    expect(rows.every((r) => r.status === '' && r.confidence === '' && r.notes === '')).toBe(true);
  });

  it('an upsert keeps the recorded result of a revised scenario', async () => {
    const byName = tools();
    await byName.get('write_qa_scenarios')!.handler({
      mode: 'replace',
      scenarios: [scenario('S-001')],
    });
    const exec = new Map(buildQaExecutionTools(CTX).map((t) => [t.name, t]));
    await exec.get('record_qa_results')!.handler({
      results: [{ id: 'S-001', status: 'pass', confidence: 3 }],
    });

    await byName.get('write_qa_scenarios')!.handler({
      mode: 'upsert',
      scenarios: [scenario('S-001', { title: 'Reworded' })],
    });
    const rows = readRows(archiveRoot);
    expect(rows[0]!.title).toBe('Reworded');
    expect(rows[0]!.status).toBe('pass');
    expect(rows[0]!.confidence).toBe('3');
  });

  it('replace over a book carrying results warns about what it discarded', async () => {
    const byName = tools();
    await byName.get('write_qa_scenarios')!.handler({
      mode: 'replace',
      scenarios: [scenario('S-001')],
    });
    const exec = new Map(buildQaExecutionTools(CTX).map((t) => [t.name, t]));
    await exec.get('record_qa_results')!.handler({
      results: [{ id: 'S-001', status: 'fail', confidence: 2, notes: 'broken' }],
    });

    const replaced = await byName.get('write_qa_scenarios')!.handler({
      mode: 'replace',
      scenarios: [scenario('S-010')],
    });
    expect(replaced.isError).not.toBe(true);
    expect(replaced.content[0]!.text).toContain('discarded 1 scenario(s)');
    expect(readRows(archiveRoot).map((r) => r.id)).toEqual(['S-010']);
  });

  it('refuses a batch carrying a duplicate id', async () => {
    const result = await tools().get('write_qa_scenarios')!.handler({
      mode: 'replace',
      scenarios: [scenario('S-001'), scenario('S-001')],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Duplicate id');
  });

  it('delete is all-or-nothing on unknown ids', async () => {
    const byName = tools();
    await byName.get('write_qa_scenarios')!.handler({
      mode: 'replace',
      scenarios: [scenario('S-001'), scenario('S-002')],
    });

    const refused = await byName.get('delete_qa_scenarios')!.handler({
      ids: ['S-001', 'S-999'],
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain('S-999');
    expect(readRows(archiveRoot)).toHaveLength(2);

    const deleted = await byName.get('delete_qa_scenarios')!.handler({ ids: ['S-001'] });
    expect(deleted.isError).not.toBe(true);
    expect(readRows(archiveRoot).map((r) => r.id)).toEqual(['S-002']);
  });

  it('rejects malformed scenario input at the schema boundary', async () => {
    await expect(
      tools().get('write_qa_scenarios')!.handler({
        mode: 'replace',
        scenarios: [scenario('not-an-id')],
      }),
    ).rejects.toThrow();
  });
});

describe('QA execution tools (the executor)', () => {
  let archiveRoot: string;

  beforeEach(async () => {
    archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-qa-exec-'));
    process.env.BOTTEGA_ARCHIVE_ROOT = archiveRoot;
    const writer = new Map(buildQaScenarioTools(CTX).map((t) => [t.name, t]));
    await writer.get('write_qa_scenarios')!.handler({
      mode: 'replace',
      scenarios: [scenario('S-001'), scenario('S-002'), scenario('S-003')],
    });
  });

  afterEach(() => {
    delete process.env.BOTTEGA_ARCHIVE_ROOT;
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  });

  const tools = () => new Map(buildQaExecutionTools(CTX).map((t) => [t.name, t]));

  it('records results into the three result cells and reports the remaining count', async () => {
    const result = await tools().get('record_qa_results')!.handler({
      results: [
        { id: 'S-001', status: 'pass', confidence: 3 },
        { id: 'S-002', status: 'fail', confidence: 1, notes: 'expected error, got silence' },
      ],
    });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).toContain('Recorded 2 result(s). 1 scenario(s) still not run.');

    const rows = readRows(archiveRoot);
    expect(rows[0]).toMatchObject({ id: 'S-001', status: 'pass', confidence: '3', notes: '' });
    expect(rows[1]).toMatchObject({
      id: 'S-002',
      status: 'fail',
      confidence: '1',
      notes: 'expected error, got silence',
    });
    // The untouched scenario keeps its descriptive cells and empty result.
    expect(rows[2]).toMatchObject({ id: 'S-003', status: '', title: 'Scenario S-003' });
  });

  it('refuses unknown ids without recording anything', async () => {
    const result = await tools().get('record_qa_results')!.handler({
      results: [
        { id: 'S-001', status: 'pass', confidence: 3 },
        { id: 'S-404', status: 'pass', confidence: 3 },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('S-404');
    expect(readRows(archiveRoot).every((r) => r.status === '')).toBe(true);
  });

  it('rejects out-of-range status/confidence at the schema boundary', async () => {
    await expect(
      tools().get('record_qa_results')!.handler({
        results: [{ id: 'S-001', status: 'maybe', confidence: 3 }],
      }),
    ).rejects.toThrow();
    await expect(
      tools().get('record_qa_results')!.handler({
        results: [{ id: 'S-001', status: 'pass', confidence: 5 }],
      }),
    ).rejects.toThrow();
  });

  it('fails loudly when the book is missing', async () => {
    fs.rmSync(csvPath(archiveRoot));
    const result = await tools().get('record_qa_results')!.handler({
      results: [{ id: 'S-001', status: 'pass', confidence: 3 }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('does not exist');
  });
});
