# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** — do not open a public issue.

Use GitHub's private vulnerability reporting: the **Security** tab →
**Report a vulnerability**, or
https://github.com/vdaubry/bottega/security/advisories/new

We'll acknowledge your report within a few business days and keep you posted on the
fix. We're happy to credit you once a fix ships (tell us if you'd rather stay
anonymous).

## Scope

This policy covers the reference implementation in [`reference/`](reference).
Bottega runs on a server you control and handles authentication, per-user
credentials, and spawns coding-agent subprocesses — so we take auth bypass,
credential exposure, command injection, and similar reports seriously.

Out of scope: vulnerabilities in the third-party agent runtimes (Claude Code,
Codex, OpenCode) or their CLIs — please report those upstream.

## Supported versions

Only the latest `main` is supported; there are no backported security releases.
