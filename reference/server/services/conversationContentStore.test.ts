import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/db-helper.js';
import { SqliteSessionStore } from './sqliteSessionStore.js';
import { ConversationContentStore, resolveProjectKey, purgeConversationMessages } from './conversationContentStore.js';

describe('ConversationContentStore', () => {
  let testDb: TestDatabase;
  // Tests call store/contentStore methods with a mix of paginated and raw shapes;
  // keeping these loose lets the test bodies stay focused on behavior, not types.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let store: any;
  let contentStore: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const projectFolderPath = '/repo/example.project';
  const claudeSessionId = 'session-1';
  let projectKey: string;

  beforeEach(() => {
    testDb = createTestDatabase();
    store = new SqliteSessionStore(testDb.db);
    contentStore = new ConversationContentStore({ store });
    projectKey = resolveProjectKey(projectFolderPath);
  });

  afterEach(() => {
    testDb.close();
  });

  async function seed(entries: unknown[]) {
    await store.append({ projectKey, sessionId: claudeSessionId }, entries);
  }

  it('resolveProjectKey replaces every non-alphanumeric char with - (mirrors SDK f1())', () => {
    // The SDK's `f1()` does `path.replace(/[^a-zA-Z0-9]/g, '-')`. Underscores
    // collapse to `-` along with `/` and `.`; we must match exactly or reads
    // miss messages the SDK wrote (e.g. /home/ubuntu/misc/hello_world).
    expect(resolveProjectKey('/repo/example_project')).toBe('-repo-example-project');
    expect(resolveProjectKey('/repo/with.dots')).toBe('-repo-with-dots');
    expect(resolveProjectKey('/tmp/path-with-dashes')).toBe('-tmp-path-with-dashes');
    expect(resolveProjectKey('/home/ubuntu/misc/hello_world')).toBe('-home-ubuntu-misc-hello-world');
  });

  it('getSessionMessages returns paginated messages from SQLite', async () => {
    await seed([
      { type: 'user', uuid: 'a', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', uuid: 'b', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: 'hi back' } },
    ]);

    const result = await contentStore.getSessionMessages(claudeSessionId, projectFolderPath);
    expect(result).toHaveLength(2);
    expect(result[0].uuid).toBe('a');
  });

  it('returns empty result when the session has no messages in SQLite', async () => {
    const result = await contentStore.getSessionMessages('not-found', projectFolderPath);
    expect(result).toEqual([]);
  });

  it('filters out queue-operation entries', async () => {
    await seed([
      { type: 'user', uuid: 'a', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hi' } },
      { type: 'queue-operation', uuid: 'q', timestamp: '2026-01-01T00:00:00.5Z' },
      { type: 'assistant', uuid: 'b', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: 'hi back' } },
    ]);

    const result = await contentStore.getSessionMessages(claudeSessionId, projectFolderPath);
    expect(result.map((e: { uuid: string }) => e.uuid)).toEqual(['a', 'b']);
  });

  it('filters out <task-notification> user entries', async () => {
    await seed([
      { type: 'user', uuid: 'a', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: '<task-notification>workflow_complete</task-notification>' } },
      { type: 'user', uuid: 'b', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: 'real message' } },
    ]);

    const result = await contentStore.getSessionMessages(claudeSessionId, projectFolderPath);
    expect(result).toHaveLength(1);
    expect(result[0].uuid).toBe('b');
  });

  it('paginates with limit + offset (returns oldest..newest, last-N window)', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      type: 'user',
      uuid: `u${i}`,
      timestamp: `2026-01-0${i + 1}T00:00:00Z`,
      message: { role: 'user', content: `m${i}` }
    }));
    await seed(entries);

    const page = await contentStore.getSessionMessages(claudeSessionId, projectFolderPath, 3, 0);
    expect(page.total).toBe(10);
    expect(page.messages.map((e: { uuid: string }) => e.uuid)).toEqual(['u7', 'u8', 'u9']);
    expect(page.hasMore).toBe(true);
  });

  it('getSessionTokenUsage extracts the latest usage record', async () => {
    await seed([
      {
        type: 'assistant',
        uuid: 'a',
        timestamp: '2026-01-01T00:00:00Z',
        message: { usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 } }
      },
      {
        type: 'assistant',
        uuid: 'b',
        timestamp: '2026-01-02T00:00:00Z',
        message: { usage: { input_tokens: 200, output_tokens: 40, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } }
      },
    ]);

    const usage = await contentStore.getSessionTokenUsage(claudeSessionId, projectFolderPath);
    expect(usage.contextUsed).toBe(210);
    expect(usage.outputTokens).toBe(40);
  });

  it('getSessionTokenUsage returns 0 for an empty session', async () => {
    const usage = await contentStore.getSessionTokenUsage('never-seen', projectFolderPath);
    expect(usage).toEqual({ tokens: 0, contextWindow: 1000000 });
  });

  it('getConversationContent returns rawEntries + source.type=sqlite', async () => {
    await seed([
      { type: 'user', uuid: 'a', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hi' } },
    ]);

    const result = await contentStore.getConversationContent({ claudeSessionId, projectFolderPath });
    expect(result.rawEntries).toHaveLength(1);
    expect(result.source).toEqual({ type: 'sqlite' });
  });

  it('patchThinking fills empty thinking blocks and upserts the entry', async () => {
    const messageId = 'msg-1';
    await seed([
      {
        type: 'assistant',
        uuid: 'asst-a',
        timestamp: '2026-01-01T00:00:00Z',
        message: {
          id: messageId,
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '' },
            { type: 'text', text: 'visible response' }
          ]
        }
      },
    ]);

    const accumulator = {
      hasContent: () => true,
      get: (id: string) => id === messageId ? new Map([[0, 'reasoning text']]) : null
    };

    const modified = await contentStore.patchThinking({
      claudeSessionId,
      projectFolderPath,
      accumulator
    });
    expect(modified).toBe(true);

    const reloaded = await store.load({ projectKey, sessionId: claudeSessionId });
    expect(reloaded[0].message.content[0].thinking).toBe('reasoning text');
    expect(reloaded[0].message.content[1].text).toBe('visible response');
    // Idempotent on uuid — exactly one row
    expect(reloaded).toHaveLength(1);
  });

  it('patchThinking is a no-op when accumulator is empty', async () => {
    const accumulator = { hasContent: () => false, get: () => null };
    const result = await contentStore.patchThinking({
      claudeSessionId,
      projectFolderPath,
      accumulator
    });
    expect(result).toBe(false);
  });

  describe('purgeConversationMessages', () => {
    it('removes messages keyed by session_path when present', async () => {
      await seed([
        { type: 'user', uuid: 'a', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hi' } },
      ]);

      await purgeConversationMessages(
        { claude_conversation_id: claudeSessionId, session_path: projectFolderPath },
        '/some/other/repo',
        store
      );

      expect(await store.load({ projectKey, sessionId: claudeSessionId })).toBeNull();
    });

    it('falls back to repo path when session_path is null (legacy rows)', async () => {
      await seed([
        { type: 'user', uuid: 'a', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hi' } },
      ]);

      await purgeConversationMessages(
        { claude_conversation_id: claudeSessionId, session_path: null },
        projectFolderPath,
        store
      );

      expect(await store.load({ projectKey, sessionId: claudeSessionId })).toBeNull();
    });

    it('is a no-op when claude_conversation_id is missing (precreated, never streamed)', async () => {
      await seed([
        { type: 'user', uuid: 'a', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hi' } },
      ]);

      await purgeConversationMessages(
        { claude_conversation_id: null, session_path: projectFolderPath },
        projectFolderPath,
        store
      );

      // Untouched
      expect(await store.load({ projectKey, sessionId: claudeSessionId })).toHaveLength(1);
    });

    it('is a no-op when neither session_path nor fallback path is provided', async () => {
      await seed([
        { type: 'user', uuid: 'a', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hi' } },
      ]);

      await purgeConversationMessages(
        { claude_conversation_id: claudeSessionId, session_path: null },
        null,
        store
      );

      expect(await store.load({ projectKey, sessionId: claudeSessionId })).toHaveLength(1);
    });
  });
});
