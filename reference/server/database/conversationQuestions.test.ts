import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('conversationQuestionsDb', () => {
  let root: string;
  let db: typeof import('./connection.js').db;
  let conversationQuestionsDb: typeof import('./conversationQuestions.js').conversationQuestionsDb;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-questions-'));
    process.env.DATABASE_PATH = path.join(root, 'test.db');
    ({ db } = await import('./connection.js'));
    db.exec(fs.readFileSync(path.join(process.cwd(), 'server/database/init.sql'), 'utf8'));
    db.prepare("INSERT INTO conversations (owner_kind, provider, model) VALUES ('task', 'openai', 'gpt-6.1-sol')").run();
    ({ conversationQuestionsDb } = await import('./conversationQuestions.js'));
  });

  afterAll(() => {
    delete process.env.DATABASE_PATH;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('persists one active question and transitions it through answer/resolution', () => {
    const created = conversationQuestionsDb.createOrGet(1, [{ question: 'Tier?' }]);
    expect(created.status).toBe('pending');
    expect(created.provider_tool_use_id).toBe(`portable-question:${created.id}`);
    // The same ask parked again (a retried park) reuses its row.
    expect(conversationQuestionsDb.createOrGet(1, [{ question: 'Tier?' }]).id).toBe(created.id);

    conversationQuestionsDb.answer(created.id, { 'Tier?': 'Pro' });
    expect(conversationQuestionsDb.active(1)?.status).toBe('answered');
    conversationQuestionsDb.reopen(created.id);
    expect(conversationQuestionsDb.pendingForConversation(1)?.id).toBe(created.id);
    conversationQuestionsDb.answer(created.id, { 'Tier?': 'Pro' });
    conversationQuestionsDb.resolve(created.id);
    expect(conversationQuestionsDb.active(1)).toBeUndefined();

    const firstRound = conversationQuestionsDb.createOrGet(1, [{ question: 'Region?' }]);
    conversationQuestionsDb.answer(firstRound.id, { 'Region?': 'EU' });
    const secondRound = conversationQuestionsDb.createOrGet(1, [{ question: 'Currency?' }]);
    expect(conversationQuestionsDb.active(1)?.id).toBe(secondRound.id);
    expect(conversationQuestionsDb.active(1)?.status).toBe('pending');
    expect(secondRound.id).not.toBe(firstRound.id);
    expect(secondRound.status).toBe('pending');
    conversationQuestionsDb.answer(secondRound.id, { 'Currency?': 'EUR' });
    conversationQuestionsDb.resolve(secondRound.id);
    expect(conversationQuestionsDb.active(1)).toBeUndefined();
  });

  // Regression: a pending row left behind (the user replied in the chat
  // composer, or a boot sweep reopened a round whose continuation had already
  // run) used to be handed to the NEXT ask — old id, old card, old text — and
  // the new question was lost.
  it('cancels a stale pending round when a different question arrives, instead of reusing it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stale = conversationQuestionsDb.createOrGet(1, [{ question: 'Deadline?' }]);

    const fresh = conversationQuestionsDb.createOrGet(1, [{ question: 'Interpretation?' }]);

    expect(fresh.id).not.toBe(stale.id);
    expect(fresh.status).toBe('pending');
    expect(JSON.parse(fresh.questions_json)).toEqual([{ question: 'Interpretation?' }]);
    expect(conversationQuestionsDb.pendingForConversation(1)?.id).toBe(fresh.id);
    const staleRow = db
      .prepare('SELECT status, resolved_at FROM conversation_questions WHERE id = ?')
      .get(stale.id) as { status: string; resolved_at: string | null };
    expect(staleRow.status).toBe('cancelled');
    expect(staleRow.resolved_at).not.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`cancelling stale pending question ${stale.id}`),
    );
    warn.mockRestore();

    conversationQuestionsDb.answer(fresh.id, { 'Interpretation?': 'Strict' });
    conversationQuestionsDb.resolve(fresh.id);
    expect(conversationQuestionsDb.active(1)).toBeUndefined();
  });
});
