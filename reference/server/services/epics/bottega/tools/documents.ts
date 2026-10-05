import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { definePortableTool as tool } from '../../../conversation/portableTool.js';
import {
  ensureEpicDirs,
  getEpicStageWritableDirs,
} from '../../epicArchive.js';
import { ok, okJson, fail, errText } from '../toolResult.js';
import type { EpicAgentType } from '@shared/types/db';

const DOCUMENT_MAX = 1_000_000;

export interface DocumentToolContext {
  projectId: number;
  epicId: number;
  agentType: EpicAgentType;
}

function inside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveArchivePath(root: string, supplied: string): string {
  const candidate = path.resolve(path.isAbsolute(supplied) ? supplied : path.join(root, supplied));
  if (!inside(candidate, root)) throw new Error('Path must stay inside this epic archive.');
  return candidate;
}

function assertWritable(candidate: string, writableDirs: string[]): void {
  if (!writableDirs.some((dir) => inside(candidate, path.resolve(dir)))) {
    throw new Error('This stage may not write that path. Use one of its assigned archive directories.');
  }
}

function assertSafeExistingPath(candidate: string, allowedRoots: string[]): void {
  if (fs.lstatSync(candidate).isSymbolicLink()) {
    throw new Error('Symbolic-link documents are not allowed.');
  }
  const realCandidate = fs.realpathSync(candidate);
  const realRoots = allowedRoots.map((root) => fs.realpathSync(root));
  if (!realRoots.some((root) => inside(realCandidate, root))) {
    throw new Error('Resolved path must stay inside its assigned epic archive directory.');
  }
}

function assertSafeWriteParent(candidate: string, allowedRoots: string[]): void {
  let existing = path.dirname(candidate);
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error('Could not resolve a safe archive parent directory.');
    existing = parent;
  }
  const realExisting = fs.realpathSync(existing);
  const realRoots = allowedRoots.map((root) => fs.realpathSync(root));
  if (!realRoots.some((root) => inside(realExisting, root))) {
    throw new Error('Resolved write path must stay inside its assigned epic archive directory.');
  }
  if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) {
    throw new Error('Writing through a symbolic link is not allowed.');
  }
}

function walkFiles(dir: string, root: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, root, out);
    else if (entry.isFile()) out.push(path.relative(root, full));
  }
}

/** Safe archive I/O shared by every harness. Repository writes never flow through these tools. */
export function buildDocumentTools(ctx: DocumentToolContext) {
  const root = ensureEpicDirs(ctx.projectId, ctx.epicId);
  const writableDirs = getEpicStageWritableDirs(ctx.agentType, ctx.projectId, ctx.epicId);

  const listDocuments = tool(
    'list_epic_documents',
    'List every document in this epic archive. Paths returned are relative to the archive root.',
    {},
    async () => {
      try {
        const files: string[] = [];
        walkFiles(root, root, files);
        return okJson(files.sort());
      } catch (error) {
        return fail(errText(error));
      }
    },
  );

  const readDocument = tool(
    'read_epic_document',
    'Read one UTF-8 document from this epic archive. Use a relative path returned by list_epic_documents.',
    { path: z.string().trim().min(1).max(1000) },
    async ({ path: suppliedPath }) => {
      try {
        const filePath = resolveArchivePath(root, suppliedPath);
        if (!fs.existsSync(filePath)) {
          return fail(`Document does not exist: ${suppliedPath}`);
        }
        assertSafeExistingPath(filePath, [root]);
        if (!fs.statSync(filePath).isFile()) {
          return fail(`Document does not exist: ${suppliedPath}`);
        }
        if (fs.statSync(filePath).size > DOCUMENT_MAX) {
          return fail(`Document exceeds ${DOCUMENT_MAX} bytes.`);
        }
        return ok(fs.readFileSync(filePath, 'utf8'));
      } catch (error) {
        return fail(errText(error));
      }
    },
  );

  const writeDocument = tool(
    'write_epic_document',
    'Create or replace a UTF-8 document in this stage\'s assigned epic archive directory. This cannot write to the repository.',
    {
      path: z.string().trim().min(1).max(1000),
      content: z.string().max(DOCUMENT_MAX),
    },
    async ({ path: suppliedPath, content }) => {
      try {
        const filePath = resolveArchivePath(root, suppliedPath);
        assertWritable(filePath, writableDirs);
        assertSafeWriteParent(filePath, writableDirs);
        if (Buffer.byteLength(content, 'utf8') > DOCUMENT_MAX) {
          return fail(`Document exceeds ${DOCUMENT_MAX} bytes.`);
        }
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const temporary = `${filePath}.bottega-${process.pid}-${Date.now()}.tmp`;
        fs.writeFileSync(temporary, content, 'utf8');
        fs.renameSync(temporary, filePath);
        return ok(`Wrote ${path.relative(root, filePath)}.`);
      } catch (error) {
        return fail(errText(error));
      }
    },
  );

  const editDocument = tool(
    'edit_epic_document',
    'Replace exact text in an existing document in this stage\'s assigned archive directories. Refuses ambiguous matches unless replaceAll is true.',
    {
      path: z.string().trim().min(1).max(1000),
      oldText: z.string().min(1).max(DOCUMENT_MAX),
      newText: z.string().max(DOCUMENT_MAX),
      replaceAll: z.boolean().optional().default(false),
    },
    async ({ path: suppliedPath, oldText, newText, replaceAll }) => {
      try {
        const filePath = resolveArchivePath(root, suppliedPath);
        assertWritable(filePath, writableDirs);
        if (!fs.existsSync(filePath)) return fail(`Document does not exist: ${suppliedPath}`);
        assertSafeExistingPath(filePath, writableDirs);
        assertSafeWriteParent(filePath, writableDirs);
        const current = fs.readFileSync(filePath, 'utf8');
        const matches = current.split(oldText).length - 1;
        if (matches === 0) return fail('The exact oldText was not found; read the document and retry.');
        if (matches > 1 && !replaceAll) return fail(`oldText matched ${matches} places; make it unique or set replaceAll.`);
        // Both branches must substitute newText literally. `String.replace`
        // would expand `$$`, `$&`, "$`" and `$'` in the replacement, so a
        // document that legitimately contains them (shell, Makefile) comes out
        // corrupted on a single-occurrence edit but correct with replaceAll.
        const next = replaceAll
          ? current.split(oldText).join(newText)
          : (() => {
              const at = current.indexOf(oldText);
              return current.slice(0, at) + newText + current.slice(at + oldText.length);
            })();
        if (Buffer.byteLength(next, 'utf8') > DOCUMENT_MAX) {
          return fail(`Edited document exceeds ${DOCUMENT_MAX} bytes.`);
        }
        const temporary = `${filePath}.bottega-${process.pid}-${Date.now()}.tmp`;
        fs.writeFileSync(temporary, next, 'utf8');
        fs.renameSync(temporary, filePath);
        return ok(`Edited ${path.relative(root, filePath)}.`);
      } catch (error) {
        return fail(errText(error));
      }
    },
  );

  return [listDocuments, readDocument, writeDocument, editDocument];
}

/**
 * The read-only half of the archive catalog — for stages that must see the
 * whole archive but write only through their own dedicated tools (the QA
 * pair). Path safety stays single-sourced in `buildDocumentTools`; this slices
 * its return, whose order (list, read, write, edit) is defined right above.
 */
export function buildDocumentReadTools(ctx: DocumentToolContext) {
  return buildDocumentTools(ctx).slice(0, 2);
}
