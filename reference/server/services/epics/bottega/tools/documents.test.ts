import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildDocumentTools } from './documents.js';

describe('portable epic document tools', () => {
  let archiveRoot: string;

  beforeEach(() => {
    archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-document-tools-'));
    process.env.BOTTEGA_ARCHIVE_ROOT = archiveRoot;
  });

  afterEach(() => {
    delete process.env.BOTTEGA_ARCHIVE_ROOT;
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  });

  it('writes, reads, edits and lists only the stage-owned archive directory', async () => {
    const tools = buildDocumentTools({ projectId: 7, epicId: 42, agentType: 'epic-architecture' });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const written = await byName.get('write_epic_document')!.handler({
      path: 'architecture/architecture.md',
      content: '# Initial',
    });
    expect(written.isError).not.toBe(true);

    const read = await byName.get('read_epic_document')!.handler({
      path: 'architecture/architecture.md',
    });
    expect(read.content[0]!.text).toBe('# Initial');

    await byName.get('edit_epic_document')!.handler({
      path: 'architecture/architecture.md',
      oldText: 'Initial',
      newText: 'Approved',
      replaceAll: false,
    });
    const listed = await byName.get('list_epic_documents')!.handler({});
    expect(JSON.parse(listed.content[0]!.text)).toContain('architecture/architecture.md');

    const denied = await byName.get('write_epic_document')!.handler({
      path: 'docs/not-owned.md',
      content: 'no',
    });
    expect(denied.isError).toBe(true);
    expect(fs.existsSync(path.join(archiveRoot, 'projects/7/epics/epic-42/docs/not-owned.md'))).toBe(false);
  });

  it('substitutes replacement text literally, whatever the dollar patterns in it', async () => {
    const tools = buildDocumentTools({ projectId: 7, epicId: 42, agentType: 'epic-architecture' });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    // Every pattern String.replace would expand in a replacement string.
    const literal = 'sed -e "s/x/$&/" && make $$PID && cp $` $\'';

    for (const replaceAll of [false, true]) {
      await byName.get('write_epic_document')!.handler({
        path: 'architecture/architecture.md',
        content: 'Install: run MARKER before tests.',
      });
      await byName.get('edit_epic_document')!.handler({
        path: 'architecture/architecture.md',
        oldText: 'MARKER',
        newText: literal,
        replaceAll,
      });
      const read = await byName.get('read_epic_document')!.handler({
        path: 'architecture/architecture.md',
      });
      expect(read.content[0]!.text).toBe(`Install: run ${literal} before tests.`);
    }
  });

  it('replaces only the first occurrence unless replaceAll is set', async () => {
    const tools = buildDocumentTools({ projectId: 7, epicId: 42, agentType: 'epic-architecture' });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    await byName.get('write_epic_document')!.handler({
      path: 'architecture/architecture.md',
      content: 'a X b X c',
    });
    await byName.get('edit_epic_document')!.handler({
      path: 'architecture/architecture.md',
      oldText: 'X',
      newText: 'Y',
      replaceAll: true,
    });
    expect(
      (await byName.get('read_epic_document')!.handler({ path: 'architecture/architecture.md' }))
        .content[0]!.text,
    ).toBe('a Y b Y c');

    await byName.get('write_epic_document')!.handler({
      path: 'architecture/architecture.md',
      content: 'a X b X c',
    });
    const ambiguous = await byName.get('edit_epic_document')!.handler({
      path: 'architecture/architecture.md',
      oldText: 'X',
      newText: 'Y',
      replaceAll: false,
    });
    expect(ambiguous.isError).toBe(true);

    await byName.get('write_epic_document')!.handler({
      path: 'architecture/architecture.md',
      content: 'a X b',
    });
    await byName.get('edit_epic_document')!.handler({
      path: 'architecture/architecture.md',
      oldText: 'X',
      newText: 'Y',
      replaceAll: false,
    });
    expect(
      (await byName.get('read_epic_document')!.handler({ path: 'architecture/architecture.md' }))
        .content[0]!.text,
    ).toBe('a Y b');
  });

  it('rejects symbolic-link traversal for reads and writes', async () => {
    const tools = buildDocumentTools({ projectId: 7, epicId: 42, agentType: 'epic-architecture' });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const epicRoot = path.join(archiveRoot, 'projects/7/epics/epic-42');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-document-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.md'), 'outside');
    fs.symlinkSync(outside, path.join(epicRoot, 'architecture', 'escape'));

    try {
      const read = await byName.get('read_epic_document')!.handler({
        path: 'architecture/escape/secret.md',
      });
      expect(read.isError).toBe(true);

      const write = await byName.get('write_epic_document')!.handler({
        path: 'architecture/escape/created.md',
        content: 'must not escape',
      });
      expect(write.isError).toBe(true);
      expect(fs.existsSync(path.join(outside, 'created.md'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
