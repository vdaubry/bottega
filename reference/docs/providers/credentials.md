# Provider credentials — per-user stores, the env-stripping invariant

Every provider's auth is **per-user**, never global. A request resolves the
current user id (`req.user.id`), and the credential layer turns that into the
on-disk token + the env the SDK invocation inherits. All three providers store
their per-user state under **`~/.config/bottega/users/{userId}/`**.

## The `ProviderCredentialStore` abstraction

`server/services/credentials/types.ts:54` defines the store contract:
`read(userId)`, `write(userId, payload)`, `clear(userId)`,
`getStatus(userId)` → `ProviderAuthStatus`, and **`buildSdkEnv(userId)`** — the
env the SDK process should inherit. Three thin adapters
(`credentials/{anthropic,openai,opencode}.ts`) wrap the older per-provider
helper modules (`claudeCredentials.ts`, `codexCredentials.ts`,
`openCodeCredentials.ts`); the adapters add no behaviour, they only re-shape the
API so callers ask **by provider name**. `credentials/registry.ts` registers all
three at module load; `getCredentialStore(provider)` (`registry.ts:27`) is the
resolution point.

When a configured provider has no usable credential, the agent runner throws a
typed **`ProviderCredentialsMissingError`** (`credentials/types.ts:13`, thrown at
`server/services/agentRunner.ts:147`) that the route layer catches
(`routes/agent-runs.ts:115`) to render a "Connect <provider>" affordance instead
of a 500.

## The global-auth-env-stripping invariant (security-critical)

The host may have provider auth in the *process* env (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, a global `CODEX_HOME`, …). Those would **override** the
per-user credential we just resolved. So every `buildSdkEnv` / spawn-env builder
**deletes the provider's global auth keys** before injecting the per-user token:

| Provider | Stripped keys | Set instead |
|---|---|---|
| anthropic | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` (`claudeCredentials.ts:11`) | per-user `CLAUDE_CODE_OAUTH_TOKEN` |
| openai | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `CODEX_HOME`, `CODEX_API_KEY` (`codexCredentials.ts:30`) | per-user `CODEX_HOME` |
| opencode | `OPENCODE_AUTH_CONTENT`, `OPENCODE_CONFIG*` (`openCodeCredentials.ts:38`) | per-user `XDG_*` dirs + auth.json |

This is the reason the env handed to each SDK is built sparsely (only `HOME`,
`PATH`, and the per-user credential) rather than spreading `process.env`. **Never
"simplify" a builder by spreading `process.env` without re-stripping** — that
re-opens cross-user credential leakage.

## Where each provider's config lives

```
~/.config/bottega/users/{userId}/
  oauth_token                    Claude OAuth token (mode 0600)   — claude.md
  codex/auth.json                Codex OAuth/API bundle (0600)    — codex.md
  opencode-data/opencode/auth.json   OpenCode Zen key (0600)      — opencode.md
  opencode-{config,state,cache}/     OpenCode XDG scratch
  .claude/                       login-subprocess sandbox (not used by SDK calls)
```

Token files are mode `0600`, dirs `0700`, and reads **re-validate** ownership +
permissions on every access (`validateTokenFileSecurity`,
`claudeCredentials.ts`) — a token owned by the wrong uid or group-readable is
rejected. The root is overridable via `CLAUDE_CONFIG_ROOT` / `CODEX_CONFIG_ROOT`
/ `OPENCODE_CONFIG_ROOT` env vars (used in tests).

## Status & "connected providers"

`getStatus(userId)` returns `authenticated | missing` with a short
`tokenFingerprint` (last 6 chars, never the token). `GET
/api/user-agent-model-settings/connected-providers`
(`routes/userAgentModelSettings.ts:65`) calls every store's `getStatus` and
returns the list of authenticated providers — this drives the first-login gate
and the model-picker filter (see [`connection-ui.md`](./connection-ui.md)).

## Key files

- `server/services/credentials/types.ts:54` — `ProviderCredentialStore` +
  `ProviderCredentialsMissingError` (`:13`).
- `server/services/credentials/registry.ts:27` — `getCredentialStore`.
- `server/services/credentials/{anthropic,openai,opencode}.ts` — the three adapters.
- `server/services/claudeCredentials.ts:11` — Claude env-strip list + `buildClaudeSdkEnv` (`:241`).
- `server/services/codexCredentials.ts:30` — Codex env-strip list + `buildCodexSdkEnv` (`:316`).
- `server/services/openCodeCredentials.ts:38` — OpenCode env-strip list.
