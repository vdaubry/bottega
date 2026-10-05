// The epic half of the archive: `~/.bottega/projects/{p}/epics/epic-{e}/`.
//
// Epic documents live OUTSIDE the repo on purpose — a ticket worktree must
// never carry the epic's big picture, so ticket agents only ever see what a
// ticket description hands them.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { buildContextPrompt } from '../documentation.js';
import {
  buildEpicContextPrompt,
  deleteEpicArchive,
  deleteEpicSpecFile,
  ensureEpicDirs,
  getEpicArchitectureDir,
  getEpicDir,
  getEpicDocsDir,
  getEpicReviewDir,
  getEpicSpecDir,
  getEpicStageWritableDirs,
  listEpicArchitectureDocs,
  listEpicDocs,
  listEpicReviewDocs,
  listEpicSpecFiles,
  readEpicArchitectureDoc,
  readEpicDoc,
  readEpicReviewDoc,
  readEpicSpecFile,
  saveEpicSpecFile,
} from './epicArchive.js';

describe('Epic archive', () => {
  let archiveRoot: string;
  const projectId = 7;
  const epicId = 42;

  beforeEach(() => {
    archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-epic-archive-'));
    process.env.BOTTEGA_ARCHIVE_ROOT = archiveRoot;
  });

  afterEach(() => {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
    delete process.env.BOTTEGA_ARCHIVE_ROOT;
  });

  it('lays the epic directories out under the project archive', () => {
    ensureEpicDirs(projectId, epicId);

    expect(getEpicDir(projectId, epicId)).toBe(
      path.join(archiveRoot, 'projects', '7', 'epics', 'epic-42'),
    );
    expect(fs.existsSync(getEpicSpecDir(projectId, epicId))).toBe(true);
    expect(fs.existsSync(getEpicArchitectureDir(projectId, epicId))).toBe(true);
    expect(fs.existsSync(getEpicDocsDir(projectId, epicId))).toBe(true);
    expect(fs.existsSync(getEpicReviewDir(projectId, epicId))).toBe(true);
  });

  it('maps each stage to the directories it may write, or to none', () => {
    expect(getEpicStageWritableDirs('epic-architecture', projectId, epicId)).toEqual([
      getEpicArchitectureDir(projectId, epicId),
    ]);
    expect(getEpicStageWritableDirs('epic-specification', projectId, epicId)).toEqual([
      getEpicDocsDir(projectId, epicId),
    ]);
    // The reviewer writes its report AND corrects every document level it
    // reviews — the uploaded functional spec included, on the user's
    // confirmation of a deviation.
    expect(getEpicStageWritableDirs('epic-spec-review', projectId, epicId)).toEqual([
      getEpicReviewDir(projectId, epicId),
      getEpicSpecDir(projectId, epicId),
      getEpicArchitectureDir(projectId, epicId),
      getEpicDocsDir(projectId, epicId),
    ]);
    expect(getEpicStageWritableDirs('epic-stories', projectId, epicId)).toEqual([]);
    expect(getEpicStageWritableDirs('epic-orchestrator', projectId, epicId)).toEqual([]);
    expect(getEpicStageWritableDirs('epic-pr-review', projectId, epicId)).toEqual([]);
  });

  it('saves, lists, reads and deletes spec files', () => {
    saveEpicSpecFile(projectId, epicId, 'spec.md', Buffer.from('# Spec'));

    expect(listEpicSpecFiles(projectId, epicId).map((f) => f.name)).toEqual(['spec.md']);
    expect(readEpicSpecFile(projectId, epicId, 'spec.md')).toBe('# Spec');
    expect(deleteEpicSpecFile(projectId, epicId, 'spec.md')).toBe(true);
    expect(listEpicSpecFiles(projectId, epicId)).toEqual([]);
  });

  it('sanitizes uploaded spec filenames instead of trusting them', () => {
    saveEpicSpecFile(projectId, epicId, '../../escape.md', Buffer.from('nope'));

    const files = listEpicSpecFiles(projectId, epicId);
    expect(files).toHaveLength(1);
    expect(files[0]!.name).not.toContain('..');
    expect(fs.existsSync(path.join(archiveRoot, 'escape.md'))).toBe(false);
  });

  it('reads docs by basename only, so traversal cannot escape the docs dir', () => {
    ensureEpicDirs(projectId, epicId);
    fs.writeFileSync(path.join(getEpicDocsDir(projectId, epicId), '00-master.md'), '# Master');
    fs.writeFileSync(path.join(archiveRoot, 'secret.md'), 'secret');

    expect(listEpicDocs(projectId, epicId).map((f) => f.name)).toEqual(['00-master.md']);
    expect(readEpicDoc(projectId, epicId, '00-master.md')).toBe('# Master');
    expect(readEpicDoc(projectId, epicId, '../../../secret.md')).toBeNull();
  });

  it('reads architecture files by basename only, and keeps them apart from docs/', () => {
    ensureEpicDirs(projectId, epicId);
    const dir = getEpicArchitectureDir(projectId, epicId);
    fs.writeFileSync(path.join(dir, 'architecture.md'), '# Topics');
    fs.writeFileSync(path.join(archiveRoot, 'secret.md'), 'secret');

    expect(listEpicArchitectureDocs(projectId, epicId).map((f) => f.name)).toEqual([
      'architecture.md',
    ]);
    expect(readEpicArchitectureDoc(projectId, epicId, 'architecture.md')).toBe('# Topics');
    expect(readEpicArchitectureDoc(projectId, epicId, '../../../secret.md')).toBeNull();
    expect(listEpicDocs(projectId, epicId)).toEqual([]);
  });

  it('reads the review report by basename only, and keeps it apart from docs/', () => {
    ensureEpicDirs(projectId, epicId);
    fs.writeFileSync(path.join(getEpicReviewDir(projectId, epicId), 'review.md'), '# Verdict');
    fs.writeFileSync(path.join(archiveRoot, 'secret.md'), 'secret');

    expect(listEpicReviewDocs(projectId, epicId).map((f) => f.name)).toEqual(['review.md']);
    expect(readEpicReviewDoc(projectId, epicId, 'review.md')).toBe('# Verdict');
    expect(readEpicReviewDoc(projectId, epicId, '../../../secret.md')).toBeNull();
    // An implementing agent sent to read one specification document must
    // never find the epic-wide review next to it.
    expect(listEpicDocs(projectId, epicId)).toEqual([]);
  });

  it('lists split documents in name order, whatever order they were written in', () => {
    ensureEpicDirs(projectId, epicId);
    const dir = getEpicArchitectureDir(projectId, epicId);
    fs.writeFileSync(path.join(dir, '02-pricing.md'), 'second');
    fs.writeFileSync(path.join(dir, '01-overview.md'), 'first');
    fs.writeFileSync(path.join(getEpicDocsDir(projectId, epicId), '01-api.md'), 'api');
    fs.writeFileSync(path.join(getEpicDocsDir(projectId, epicId), '00-master.md'), 'master');

    expect(listEpicArchitectureDocs(projectId, epicId).map((f) => f.name)).toEqual([
      '01-overview.md',
      '02-pricing.md',
    ]);
    expect(listEpicDocs(projectId, epicId).map((f) => f.name)).toEqual([
      '00-master.md',
      '01-api.md',
    ]);
  });

  it('deletes the whole epic archive, idempotently', () => {
    saveEpicSpecFile(projectId, epicId, 'spec.md', Buffer.from('# Spec'));

    deleteEpicArchive(projectId, epicId);
    expect(fs.existsSync(getEpicDir(projectId, epicId))).toBe(false);
    expect(() => deleteEpicArchive(projectId, epicId)).not.toThrow();
  });

  describe('buildEpicContextPrompt', () => {
    it('hands the agent absolute archive paths and a must-read spec list', () => {
      saveEpicSpecFile(projectId, epicId, 'spec.md', Buffer.from('# Spec'));

      const prompt = buildEpicContextPrompt(projectId, epicId);

      expect(prompt).toContain(getEpicSpecDir(projectId, epicId));
      expect(prompt).toContain(getEpicDocsDir(projectId, epicId));
      expect(prompt).toContain(path.join(getEpicSpecDir(projectId, epicId), 'spec.md'));
      expect(prompt).toMatch(/MUST read/i);
    });

    it('says so plainly when no spec has been uploaded', () => {
      const prompt = buildEpicContextPrompt(projectId, epicId);

      expect(prompt).toMatch(/No spec files have been uploaded/i);
    });

    it('lists the technical-spec documents once they exist', () => {
      ensureEpicDirs(projectId, epicId);
      fs.writeFileSync(path.join(getEpicDocsDir(projectId, epicId), '00-master.md'), '# Master');

      const prompt = buildEpicContextPrompt(projectId, epicId);

      expect(prompt).toContain('00-master.md');
    });

    it('lists the architecture document once it exists', () => {
      ensureEpicDirs(projectId, epicId);
      fs.writeFileSync(
        path.join(getEpicArchitectureDir(projectId, epicId), 'architecture.md'),
        '# Topics',
      );

      const prompt = buildEpicContextPrompt(projectId, epicId, 'epic-specification');

      expect(prompt).toContain(
        path.join(getEpicArchitectureDir(projectId, epicId), 'architecture.md'),
      );
    });

    it('names every archive directory, including the architecture and review ones', () => {
      const prompt = buildEpicContextPrompt(projectId, epicId);

      expect(prompt).toContain(getEpicSpecDir(projectId, epicId));
      expect(prompt).toContain(getEpicArchitectureDir(projectId, epicId));
      expect(prompt).toContain(getEpicDocsDir(projectId, epicId));
      expect(prompt).toContain(getEpicReviewDir(projectId, epicId));
      // The documents ARE the hand-off between stages: no sign-off notes
      // directory, no "Completed Stages" section.
      expect(prompt).not.toContain('summaries');
      expect(prompt).not.toContain('Completed Stages');
    });

    it("tells a stage run the one directory it may write — the stage's own", () => {
      const architecture = buildEpicContextPrompt(projectId, epicId, 'epic-architecture');
      expect(architecture).toContain(
        `\`${getEpicArchitectureDir(projectId, epicId)}\` is the ONLY directory`,
      );
      expect(architecture).toContain('(enforced)');

      const specification = buildEpicContextPrompt(projectId, epicId, 'epic-specification');
      expect(specification).toContain(
        `\`${getEpicDocsDir(projectId, epicId)}\` is the ONLY directory`,
      );

      // The reviewer is told all four of its directories, in one rule — and
      // the spec line stops calling the functional specification read-only.
      const review = buildEpicContextPrompt(projectId, epicId, 'epic-spec-review');
      expect(review).toContain(
        `\`${getEpicReviewDir(projectId, epicId)}\`, \`${getEpicSpecDir(projectId, epicId)}\`, ` +
          `\`${getEpicArchitectureDir(projectId, epicId)}\`, \`${getEpicDocsDir(projectId, epicId)}\` ` +
          'are the ONLY directories',
      );
      expect(review).toContain('(enforced)');
      expect(review).toContain("amended by the specification review on the user's confirmation");
      expect(review).not.toContain('read-only');
      // Every other stage still sees it as read-only.
      expect(buildEpicContextPrompt(projectId, epicId, 'epic-specification')).toContain(
        'uploaded by the user, read-only',
      );
    });

    it('tells a stage that writes nothing exactly that', () => {
      const prompt = buildEpicContextPrompt(projectId, epicId, 'epic-stories');

      expect(prompt).toContain('This stage writes no files');
      expect(prompt).not.toContain('(enforced)');
    });

    it('tells the PR reviewer its worktree is the one place it writes, and the archive is read-only', () => {
      const prompt = buildEpicContextPrompt(projectId, epicId, 'epic-pr-review');

      expect(prompt).toContain("ticket's git worktree");
      expect(prompt).toContain('read-only');
      expect(prompt).not.toContain('This stage writes no files');
      expect(prompt).not.toMatch(/ONLY directory/);
      // It still gets the spec paths — that is what it reviews against.
      expect(prompt).toContain('Functional Specification');
    });

    it('claims no enforcement for a manual chat that runs no stage', () => {
      const prompt = buildEpicContextPrompt(projectId, epicId);

      expect(prompt).toContain('not bound to a stage');
      expect(prompt).not.toContain('(enforced)');
      expect(prompt).not.toMatch(/ONLY directory/);
    });

    it('never leaks epic paths into the TASK context prompt (isolation)', () => {
      saveEpicSpecFile(projectId, epicId, 'spec.md', Buffer.from('# Spec'));

      const taskPrompt = buildContextPrompt(projectId, 123);

      expect(taskPrompt).not.toContain('epics/epic-42');
      expect(taskPrompt).not.toContain(getEpicDocsDir(projectId, epicId));
    });
  });
});
