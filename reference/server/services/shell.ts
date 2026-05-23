import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface RunCommandOptions {
  cwd?: string;
  timeout?: number;
  // Maximum stdout/stderr buffer. Node's default is 1 MB; PR descriptions and
  // gh API JSON payloads can exceed that.
  maxBuffer?: number;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
}

// Centralized exec wrapper. Every shell-out in the codebase goes through this
// helper. By construction it uses `execFile` (NOT `exec`), so each argument
// is passed as a separate argv element — adversarial inputs like
// `$(rm -rf ~)`, backticks, semicolons, or newlines become literal bytes
// rather than shell metacharacters.
//
// There is no `shell: true` escape hatch. Callers that previously relied on
// shell pipelines (e.g. `lsof ... | xargs kill`) must reproduce the pipeline
// in JavaScript.
export async function runCommand(
  cmd: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  const { stdout, stderr } = await execFileAsync(cmd, args.slice(), {
    cwd: options.cwd,
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    encoding: 'utf8',
  });
  return { stdout, stderr };
}
