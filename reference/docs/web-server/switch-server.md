# Switch Server — live worktree preview & the `.bottega/switch.sh` activation hook

"Switch server" lets you point a project's **NGINX-served symlink** at one of its
git worktrees (or back at the main repo) so you can live-test a branch at the
project's public URL without a separate deploy.

Three things can be served: the **main checkout**, a **ticket's worktree**, or an
**epic's delivery worktree** — the epic feature branch, i.e. every merged ticket
together. The epic case matters because a ticket's own worktree is deleted when
it merges: by the time an epic is finished, the branch that has all of it is the
only thing left to preview ([`../epics/delivery.md`](../epics/delivery.md)). The generic part — flip the
symlink, restart the app — is built in. The stack-specific part — building
compiled assets, running migrations, restarting a long-running process, warming an
in-memory registry — is delegated to an **optional, per-project hook** that ships
inside the repo: `.bottega/switch.sh`.

This makes the feature generic: Bottega needs no per-project or per-stack knowledge.
A project that auto-reloads (e.g. a Rails dev server) needs no hook at all; a
project with a build step or a long-running backend ships a `.bottega/switch.sh`
that does whatever that stack requires.

## How a switch works

Configure three fields per project in **Project Settings**
(`src/pages/ProjectEditPageWrapper.tsx`):

- **`serve_symlink_path`** — the absolute path of the symlink NGINX serves (e.g.
  `/var/www/myapp/current`).
- **`systemd_service_name`** — the `systemctl --user` unit that runs the app (used
  by the fallback path; also the conventional thing a hook restarts).
- **`app_url`** — where the switched app is reachable (opened after a switch).

You trigger a switch from the **Switch Server** button — on the task page
(`src/components/TaskDetailView.tsx`) for a ticket, in the epic page's Delivery
section (`src/components/epic/EpicDeliverySection.tsx`) for an epic. Both render
the same `ServeSwitchButton` and call the same
`POST /api/projects/:id/web-server/switch` with `{taskId}` or `{epicId}` (both
null resets to main; both set is a 400). The switch is authorized by **project
membership** (any member may switch — see the security note below), and runs this
sequence in `switchServedTarget` (`server/services/webServerManager.ts`):

1. Verify project membership (via `getProject(projectId, userId)`) and that
   `serve_symlink_path` + `systemd_service_name` are configured and valid
   (absolute path; service name matching `^[a-zA-Z0-9@_-]+$`).
2. Resolve the **target path** for the `ServeTarget`:
   - `main` — the repo root (the `subproject_path` subfolder for a monorepo);
   - `task` — verify the task belongs to the project and its worktree exists
     ([`../agents/worktrees-and-pr.md`](../agents/worktrees-and-pr.md));
   - `epic` — delegate to the **`EpicServeResolver`** registered at boot, which
     validates the epic against the project and *creates* its delivery worktree
     if this is the first time it is needed. This module is shared
     infrastructure and may not import the epic layer (architecture-v2 rule 1),
     so it asks through the interface — the same shape as the conversation
     runtime's owner adapters.
3. **Flip the symlink atomically** (`ln -sfn <target> <serve_symlink_path>`).
   There is no provisioning step and no dependency-readiness gate here: the
   project's own `post-checkout` hook ran synchronously inside
   `git worktree add`
   ([`../agents/worktree-provisioning.md`](../agents/worktree-provisioning.md)),
   so a worktree that exists is as runnable as it will ever be. A worktree
   from a hookless repo is served as-is — if it cannot boot, that is the
   project's hook to write, not Bottega's to paper over.
4. **Run the activation hook _or_ fall back to systemctl** (see next section).
5. Persist what is now served on the project — `active_worktree_task_id` **and**
   `active_worktree_epic_id`, both written on every switch, which is what keeps
   "at most one is set" true without a CHECK constraint.

> **Two different hooks, do not confuse them.** `post-checkout` (git's, in the
> project repo) makes a worktree *runnable* when it is **created**.
> `.bottega/switch.sh` (Bottega's, below) builds and restarts the app when a
> worktree starts being **served**.

## What is being served, and taking it back

`GET /api/projects/:id/web-server` answers `activeTaskId`, `activeEpicId` and
**`activeName`** — the ticket title or the epic name, resolved server-side so
every surface says the same thing without holding both lists. That is what the
project board's **"Serving: …"** pill reads (`BoardView`), on the Tasks and Epics
tabs alike; its **✕** resets to the main checkout, as does the right half of the
green *Active Server* split button on either detail page.

Deleting a task that is the active server resets to main automatically
(`routes/tasks.ts`). Deleting an *epic* does not: the column is left pointing at
a row that no longer exists, and the indicator degrades to `Epic #id` until the
next switch.

## The activation hook: `.bottega/switch.sh`

After flipping the symlink, Bottega looks for **`.bottega/switch.sh`** in the
target (`<target>/.bottega/switch.sh`; for a monorepo, under the served
`subproject_path`).

- **If it exists and is executable**, Bottega runs it and **skips `systemctl`
  entirely** — the hook owns the full build + restart for that stack.
- **If it is absent _or_ present but not executable**, Bottega silently falls back
  to the legacy path: `systemctl --user stop <service>` → free the unit's `PORT` →
  `systemctl --user start <service>`.

> **The executable bit is the on-switch.** A `.bottega/switch.sh` that isn't
> `chmod +x` is treated as "no hook" — Bottega falls back to systemctl with no
> error. If your hook seems to be ignored, check `ls -l .bottega/switch.sh` first.

### The contract

When Bottega runs your hook (`runSwitchScript` in `webServerManager.ts`):

| Aspect | Value |
|---|---|
| **Path** | `<target>/.bottega/switch.sh`, relative to the served target (worktree, or subproject for a monorepo). |
| **Enabled when** | The file exists **and** is executable (`chmod +x`). Otherwise → systemctl fallback. |
| **Invocation** | Executed directly (via `execFile`, no shell wrapping the call) under its own shebang. Give it `#!/usr/bin/env bash`. |
| **Working directory** | The new symlink target (the worktree / subproject root). |
| **Environment** | The full server environment, **plus** `BOTTEGA_TARGET_PATH`, `BOTTEGA_PROJECT_ID`, and `BOTTEGA_TASK_ID`. |
| **`BOTTEGA_TASK_ID`** | The task id for a ticket-worktree switch; the **empty string** otherwise (an epic switch, or a main-repo reset). Unchanged in meaning, so hooks written before epics could be served keep working. |
| **`BOTTEGA_EPIC_ID`** | The epic id for an epic-worktree switch; the **empty string** otherwise. At most one of the two is ever non-empty. |
| **systemctl** | **Not** run when the hook runs. Your hook must restart the app itself. |
| **Timeout** | **30 seconds** wall-clock. Overrunning counts as a failure. |
| **Success** | Exit code **0**. |
| **Output on success** | stdout/stderr go to the **server logs only** (`journalctl --user -u bottega`); they are **not** shown in the UI. |
| **Output on failure** | The switch still reports success, with a **warning** carrying the script's stderr (truncated to 4096 bytes), shown in the red banner on the task page. |

### Failure policy: warn, don't abort

The symlink is flipped **before** the hook runs, and the active worktree is
persisted **even if the hook fails**. So a failing hook means *"the served files
were switched, but the app may be broken"* — the switch is reported as successful
with a warning (the stderr, truncated to 4096 bytes), surfaced in the red banner in
`TaskDetailView`. There is no automatic rollback of the symlink.

Two consequences for hook authors:

- Because **success-path stdout is hidden**, run your **own health check at the end
  of the hook and `exit` non-zero** if the app isn't actually serving. That's the
  only way a silent failure (service up but not responding) becomes a visible
  warning.
- Keep the hook **idempotent and fast** (see the 30 s budget below) so a retry is
  always safe.

## When you need a hook (and when you don't)

- **No hook needed** — stacks that pick up the new symlink on their own: a dev
  server with auto-reload (Rails `bin/rails server`, a watch-mode process reading
  from the served path). The systemctl fallback restarts the unit; that's enough.
- **Hook needed** — stacks with **compiled assets, generated bundles, database
  migrations, or in-memory state loaded at boot**: a production Vite/esbuild build,
  Django `collectstatic` + `migrate`, an app whose registry is read once at startup,
  or anything needing a multi-step restart.

## Examples

Each example is a complete `.bottega/switch.sh`. Make it executable:
`chmod +x .bottega/switch.sh` and commit it on the branch you want to preview.

### Node / Vite app with a long-running service

```bash
#!/usr/bin/env bash
set -euo pipefail
# cwd is the worktree root; dependencies are already present (the repo's
# post-checkout hook installed them when the worktree was created).

npm run build
systemctl --user restart myapp.service

# Self health-check so a non-responsive app surfaces as a UI warning.
for _ in $(seq 1 10); do
  if curl -fsS "http://127.0.0.1:${PORT:-3000}/health" >/dev/null; then
    exit 0
  fi
  sleep 1
done
echo "myapp did not become healthy in time" >&2
exit 1
```

### Django

```bash
#!/usr/bin/env bash
set -euo pipefail

python manage.py collectstatic --noinput
python manage.py migrate --noinput
systemctl --user restart myapp-django.service
curl -fsS "http://127.0.0.1:8000/healthz" >/dev/null
```

### Static site (no long-running service)

```bash
#!/usr/bin/env bash
set -euo pipefail
npm run build      # NGINX serves the built output from the symlinked target
```

### A fuller example: build, restart, health-check

A project whose activation is "build the web bundle, restart the service, hit
`/api/status`" maps directly onto the `.bottega/switch.sh` contract — drop any
generic install/build wrappers and let the hook do the project's actual steps:

```bash
#!/usr/bin/env bash
set -euo pipefail
# Bottega has already flipped the symlink and will NOT run systemctl for us.

npm run build:web                          # frontend + MCP iframe bundles
systemctl --user restart myapp-dev.service     # reloads the in-process MCP registry
curl -fsS "http://127.0.0.1:3006/api/status" >/dev/null  # fail loud if unhealthy
```

## Gotchas

- **`chmod +x` is mandatory.** No executable bit → Bottega falls back to systemctl
  silently. This is the most common "my hook didn't run."
- **You restart the service, not Bottega.** When the hook runs, systemctl is
  skipped. If your hook forgets to restart, the app keeps running the old code even
  though the files switched.
- **30 s budget.** The hook is killed at 30 seconds. Keep one-time costs (dependency
  installs) out of the hot path — that is the *post-checkout* hook's job at worktree
  creation, so `switch.sh` can assume deps exist. A full build + restart + short
  health check that overruns 30 s will be reported as a timeout failure.
- **stdout is hidden on success.** Only stderr-on-failure reaches the UI. End the
  hook with a real health check and `exit 1` on failure so problems are visible.
- **Monorepos:** the hook lives under the served subproject
  (`<repo>/<subproject_path>/.bottega/switch.sh`), not the repo root.
- **The hook runs as the Bottega server user** with the server's full environment
  (secrets included). Don't echo secrets — stdout/stderr land in the server logs.

## Security

The switch routes are mounted behind authentication and authorized by **project
membership** (the same model documented in
[`../auth/authorization.md`](../auth/authorization.md)), not admin. Any project
member who can switch the server can cause that branch's `.bottega/switch.sh` to
execute on the host, as the Bottega server user, with the server's environment.
This is arbitrary code execution by design and is an accepted part of Bottega's
trust model (all users are trusted; project content is trusted). Guards in place:
the executable-bit requirement, validated symlink path and service name, direct
`execFile` (no shell metacharacter injection into the invocation), the 30 s
timeout, and the 4096-byte stderr cap on the warning.

## Key files

- `server/services/webServerManager.ts` — `switchServedTarget` (the full switch
  flow), the `ServeTarget` union, the `EpicServeResolver` registry,
  `runSwitchScript` (the hook runner), `SWITCH_SCRIPT_RELPATH = '.bottega/switch.sh'`,
  the systemctl fallback, `killProcessesOnPort`.
- `server/services/epics/serveTarget.ts` — the epic side of that resolver
  (validate epic↔project, ensure the delivery worktree, name it).
- `server/services/worktree.ts` — `worktreeProvisioningMode` (`hook` vs `none`,
  behind the settings warning); see
  [`../agents/worktree-provisioning.md`](../agents/worktree-provisioning.md).
- `server/routes/webServer.ts` — `GET/PUT/POST` `/api/projects/:id/web-server*`
  routes (status, config, switch, verify).
- `src/components/ServeSwitchButton.tsx` — the Switch Server / Active Server /
  reset control, used by both detail pages.
- `src/components/TaskDetailView.tsx` — the ticket call site and the warning banner.
- `src/components/epic/EpicDeliverySection.tsx` — the epic call site.
- `src/components/Dashboard/BoardView.tsx` — the "Serving: …" pill and its reset.
- `src/pages/ProjectEditPageWrapper.tsx` — the `serve_symlink_path`,
  `systemd_service_name`, and `app_url` configuration fields.
