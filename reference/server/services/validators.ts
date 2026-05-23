// Defense-in-depth input checks for values that flow into command-line
// arguments. `runCommand` already passes everything via argv (no shell
// interpretation), so an unsanitized string cannot break out into a new
// command. The checks below catch a different class of problem: a malicious
// value that looks like a flag (`--upload-pack=…`), traverses the filesystem
// (`../etc/passwd`), or targets an unintended unit (`bottega.service`
// instead of a project's own service).

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// Branch names: git's own rules are more permissive than we need. We allow
// a tight subset that matches everything `sanitizeTitle()` produces plus
// `main`, `master`, `develop`, and `feature/foo` style names. Disallow
// leading `-` so a value cannot be mistaken for a flag.
const BRANCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_./-]*$/;

export function assertValidBranchName(name: string, label = 'branch'): string {
  if (typeof name !== 'string' || !BRANCH_NAME_RE.test(name) || name.includes('..')) {
    throw new ValidationError(`Invalid ${label} name: ${JSON.stringify(name)}`);
  }
  return name;
}

// systemd unit names: matches the write-side check in webServerManager.ts
// (alphanumerics, `-`, `_`, and `@` for template instances).
const SERVICE_NAME_RE = /^[a-zA-Z0-9@_-]+$/;

export function assertValidServiceName(name: string): string {
  if (typeof name !== 'string' || !SERVICE_NAME_RE.test(name)) {
    throw new ValidationError(`Invalid systemd service name: ${JSON.stringify(name)}`);
  }
  return name;
}

export function assertValidPort(port: number | string): number {
  const n = typeof port === 'number' ? port : Number.parseInt(port, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ValidationError(`Invalid port: ${JSON.stringify(port)}`);
  }
  return n;
}

const REPO_FULL_NAME_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function assertValidRepoFullName(name: string): string {
  if (typeof name !== 'string' || !REPO_FULL_NAME_RE.test(name)) {
    throw new ValidationError(`Invalid GitHub repo full name: ${JSON.stringify(name)}`);
  }
  return name;
}

export function assertValidPositiveInt(n: number, label = 'value'): number {
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError(`Invalid ${label}: ${JSON.stringify(n)}`);
  }
  return n;
}

// App URLs are opened with `window.open()` in the browser, so restrict them
// to http/https. This blocks `javascript:` and other script-bearing schemes
// from being smuggled into a stored project field.
export function assertHttpUrl(value: string, label = 'app URL'): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ValidationError(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(`${label} must use http or https: ${JSON.stringify(value)}`);
  }
  return value;
}

export function assertAbsolutePath(p: string, label = 'path'): string {
  if (typeof p !== 'string' || p.length === 0 || p[0] !== '/' || p.includes('\0')) {
    throw new ValidationError(`Invalid absolute ${label}: ${JSON.stringify(p)}`);
  }
  if (p.split('/').some((segment) => segment === '..')) {
    throw new ValidationError(`${label} must not contain ".." segments: ${JSON.stringify(p)}`);
  }
  return p;
}
