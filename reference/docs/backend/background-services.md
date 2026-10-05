# Background services — push notifications, the archive, demo seeding

Cross-cutting backend services not owned by one domain: OneSignal push, the
`~/.bottega` filesystem archive, file uploads, and the demo seeder. The startup
that wires them is [`server-bootstrap.md`](./server-bootstrap.md).

## Push notifications (OneSignal)

`server/services/notifications.ts` wraps OneSignal. It links iOS/web devices to
backend users via OneSignal's **`external_id`** (= the Bottega user id), so a
notification targets a user across devices. The client is lazy + env-gated
(`ONESIGNAL_APP_ID` / `ONESIGNAL_REST_API_KEY`); `isConfigured()` is false and all
sends no-op when unset. The exported surface:

- **`notifyClaudeComplete(...)`** — fired from the conversation completion handler
  when a turn ends (see [`../conversations/lifecycle-and-streaming.md`](../conversations/lifecycle-and-streaming.md)).
- **`updateUserBadge` / `sendBadgeUpdate` / `getInProgressTaskCount`** — keep the
  app-icon badge in sync with the user's in-progress task count.
- **`notifyTaskStatusChange` / `sendBannerNotification`** — task-status banners.

## The `~/.bottega` filesystem archive

`server/services/documentation.ts` owns a per-project/task archive that lives
**outside the repo** (so it survives a worktree-deleting PR merge), rooted at
`BOTTEGA_ARCHIVE_ROOT` (default `~/.bottega`):

```
~/.bottega/projects/{projectId}/
  tasks/task-{taskId}.md                    # the task doc (plan/spec)
  tasks/task-{taskId}/input_files/          # uploaded context files
  recordings/task-{taskId}.webm             # review-agent Playwright video
~/.bottega/conversations/{conversationId}/
  images/{fileName}                         # images the model generated
```

The `conversations/` branch is `server/services/conversationImages.ts` — keyed
by conversation rather than project because conversations are owner-less; see
[`../conversations/features.md`](../conversations/features.md).

Helpers: `getTaskDocPath` / `readTaskDoc` / `writeTaskDoc`, `getTaskInputFilesPath`
/ `saveTaskInputFile` / `listTaskInputFiles`, `getRecordingPath` (the review
agent's video destination — see [`../conversations/features.md`](../conversations/features.md)),
and `buildContextPrompt` which folds the doc + input files into the agent system
prompt. (`~/.bottega` also holds the prompt overrides from
[`../agents/prompt-templates.md`](../agents/prompt-templates.md).)

## File uploads

`server/middleware/upload.ts` is a thin `multer` (memory storage) instance.
Routes that accept uploads use it, then persist via `documentation.ts`
(`saveConversationUpload` writes into the repo's `tmp` folder;
`saveTaskInputFile` into the task archive).

## The demo seeder

`server/services/demoSeeder.ts` (`seedDemoProject(userId, opts)`, `:104`) creates
a first sample project + task by copying an example tree and `git init`-ing it,
so a fresh install isn't empty. It's **idempotent** — `isDemoAlreadySeeded()`
short-circuits, and it reuses an existing seeded repo rather than re-copying. (It's
a standalone service; invoke it from a setup path rather than assuming it runs on
every boot.)

## Key files

- `server/services/notifications.ts` — OneSignal push (`notifyClaudeComplete`, `updateUserBadge`, …); env-gated.
- `server/services/documentation.ts` — the `~/.bottega` archive (task docs / input_files / recordings) + `buildContextPrompt`.
- `server/middleware/upload.ts` — the `multer` memory-storage upload instance.
- `server/services/demoSeeder.ts:104` — `seedDemoProject` (idempotent first-run sample data).
