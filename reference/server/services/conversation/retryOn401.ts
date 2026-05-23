// Auto-recovery for the "stale subprocess" auth failure.
//
// The Claude Agent SDK spawns a `claude` CLI subprocess per `query()` call and
// that subprocess loads its auth credential exactly once, at startup. When a
// turn runs long the derived credential ages out mid-stream, and because we
// authenticate via a static `CLAUDE_CODE_OAUTH_TOKEN` (and the SDK strips the
// refresh token out of the `.credentials.json` it copies into the subprocess
// sandbox) the subprocess has no in-process refresh path — every subsequent API
// call then returns `Failed to authenticate. API Error: 401 Invalid
// authentication credentials`, before any tool call. The on-disk token is still
// valid; a *fresh* subprocess works fine. So on this specific error we tear the
// dead subprocess down and resume the conversation once in a new one.

/** How many times to transparently recycle the subprocess on a 401 before giving up. */
export const MAX_AUTH_RETRIES = 1;

/** Short pause before the retry, to ride out any transient server-side blip. */
export const AUTH_RETRY_BACKOFF_MS = 1500;

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The CLI surfaces the API 401 either as a thrown "Claude Code returned an error
// result: Failed to authenticate. API Error: 401 …" or, defensively, as a bare
// "401 Invalid authentication credentials". Match both.
const AUTH_ERROR_PATTERN = /Failed to authenticate\. API Error: 401|401 Invalid authentication credentials/i;

/** True when `error` is the SDK's "subprocess auth credential rejected" failure. */
export function isClaudeAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return AUTH_ERROR_PATTERN.test(message);
}
