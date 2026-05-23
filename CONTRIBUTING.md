# Contributing to Bottega

Bottega is a **spec-first** project — the specification is the product. A complete
reference implementation lives in [`reference/`](reference), but it's a *citation*
for the spec, not a one-size-fits-all tool meant to accumulate features.

> **In short: grow the spec, fix the reference, fork for everything else.**

The most valuable contribution is to **build your own version** — point a coding
agent at [`SPEC.md`](SPEC.md), adapt it to your team, and tell us about it in
[Discussions](https://github.com/vdaubry/bottega/discussions).

## What we accept

| Contribution | Welcome? | Where |
|---|---|---|
| **Spec changes** — new/improved `extra/` features, clearer `core/` docs, `SPEC.md` fixes | ✅ Encouraged | PR touching `SPEC.md` / `core/` / `extra/` |
| **Reference bug fixes** — defects, or realigning the reference with the spec | ✅ Yes | PR touching `reference/` |
| **New reference features** | ❌ Propose as an `extra/` spec instead | New `extra/` spec PR |
| **Questions, ideas, show-and-tell** | 💬 | [Discussions](https://github.com/vdaubry/bottega/discussions) |

Keep [Issues](https://github.com/vdaubry/bottega/issues) for **bug reports**
and **spec PRs**; everything else belongs in Discussions.

## Working on the reference implementation

The app lives in [`reference/`](reference); all commands run from there.

**Prerequisites:** Node.js 18+ (tested on 20 and 22), pnpm 11
(`npm install -g pnpm@11`), and at least one agent runtime (Claude Code, Codex,
or OpenCode) installed on the host.

```bash
git clone https://github.com/vdaubry/bottega.git
cd bottega/reference
pnpm install
cp .env.example .env
openssl rand -hex 64        # paste as JWT_SECRET in .env
pnpm onboarding             # creates an admin account + seeds a sample project
pnpm dev                    # frontend :5173, backend :3001
```

See the [README](README.md#running-the-reference-implementation) for the full
walkthrough, including connecting a provider.

## Before you open a PR

- **Add or update tests** for any code you change.
- **Run the suite** green: `pnpm test:run`.
- The project is **TypeScript-only** — CI rejects new `.js`/`.jsx` outside the allowlist.
- Keep the change focused; the PR template prompts you for *what* and *why*.

Be kind and constructive — we want Discussions and PRs to stay welcoming.
