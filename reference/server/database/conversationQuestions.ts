import { randomUUID } from 'crypto';
import { db } from './connection.js';

export interface ConversationQuestionRow {
  id: string;
  conversation_id: number;
  provider_tool_use_id: string | null;
  questions_json: string;
  answers_json: string | null;
  status: 'pending' | 'answered' | 'resolved' | 'cancelled';
  created_at: string;
  answered_at: string | null;
  resolved_at: string | null;
}

function active(conversationId: number): ConversationQuestionRow | undefined {
  try {
    return db.prepare(
      `SELECT * FROM conversation_questions
       WHERE conversation_id = ? AND status IN ('pending', 'answered')
       ORDER BY created_at DESC LIMIT 1`,
    ).get(conversationId) as ConversationQuestionRow | undefined;
  } catch (error) {
    // Narrow unit-test schemas may omit this new infrastructure table.
    if (error instanceof Error && error.message.includes('no such table')) return undefined;
    throw error;
  }
}

function pending(conversationId: number): ConversationQuestionRow | undefined {
  try {
    return db.prepare(
      `SELECT * FROM conversation_questions
       WHERE conversation_id = ? AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
    ).get(conversationId) as ConversationQuestionRow | undefined;
  } catch (error) {
    if (error instanceof Error && error.message.includes('no such table')) return undefined;
    throw error;
  }
}

export const conversationQuestionsDb = {
  createOrGet(conversationId: number, questions: unknown[], providerToolUseId: string | null = null) {
    const questionsJson = JSON.stringify(questions);
    // A pending row is reusable only for the SAME ask (a park retried before
    // its answer landed). A different question arriving while an older one is
    // still pending means that round was never answered through the widget —
    // the user replied in the chat composer, or a boot sweep reopened a round
    // whose continuation had already run. Reusing it would hand the new
    // question the old row (old id, old card, old text) and lose the new one.
    // Cancel the stale round, loudly, and give the new one its own row.
    const existing = pending(conversationId);
    if (existing) {
      if (existing.questions_json === questionsJson) return existing;
      console.warn(
        `[ask_user] Conversation ${conversationId}: cancelling stale pending question ${existing.id} ` +
          `(asked ${existing.created_at}) — a different question arrived before it was answered`,
      );
      db.prepare(
        `UPDATE conversation_questions SET status = 'cancelled', resolved_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'pending'`,
      ).run(existing.id);
    }
    // An earlier round can be `answered` while its continuation turn is
    // running; reaching another ask proves the continuation consumed every
    // answered round before it. Resolve those rows before inserting the new
    // pending round so multi-round conversations remain auditable and
    // unambiguous.
    db.prepare(
      `UPDATE conversation_questions
       SET status = 'resolved', resolved_at = COALESCE(resolved_at, CURRENT_TIMESTAMP)
       WHERE conversation_id = ? AND status = 'answered'`,
    ).run(conversationId);
    const id = randomUUID();
    // Remote harnesses abort the MCP request before their SDK emits a
    // completed tool-call event. Give those questions a stable transcript id
    // so Bottega can persist/render the card and its eventual result itself.
    const toolUseId = providerToolUseId ?? `portable-question:${id}`;
    db.prepare(
      `INSERT INTO conversation_questions
       (id, conversation_id, provider_tool_use_id, questions_json)
       VALUES (?, ?, ?, ?)`,
    ).run(id, conversationId, toolUseId, questionsJson);
    return active(conversationId)!;
  },
  active,
  pendingForConversation(conversationId: number) {
    return pending(conversationId);
  },
  answer(id: string, answers: Record<string, string>) {
    db.prepare(
      `UPDATE conversation_questions SET status = 'answered', answers_json = ?, answered_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'pending'`,
    ).run(JSON.stringify(answers), id);
  },
  resolve(id: string) {
    db.prepare(
      `UPDATE conversation_questions SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'answered'`,
    ).run(id);
  },
  reopen(id: string) {
    db.prepare(
      `UPDATE conversation_questions SET status = 'pending', answers_json = NULL, answered_at = NULL
       WHERE id = ? AND status = 'answered'`,
    ).run(id);
  },
};
