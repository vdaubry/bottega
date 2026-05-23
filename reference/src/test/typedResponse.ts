/**
 * Build a minimal mocked TypedResponse for tests.
 *
 * Production callers read at most `ok`, `status`, and `json()` from the
 * `Response` returned by `src/utils/api.ts`. The full DOM `Response`
 * surface is large; tests only need the subset they exercise. This
 * helper wraps the minimal shape and casts back to the strict
 * `TypedResponse<T>` so the call site stays inference-friendly.
 */
export const mockTypedResponse = <T,>(
  json: T,
  init: { ok?: boolean; status?: number } = {},
): Response & { json(): Promise<T> } => {
  const { ok = init.status === undefined ? true : init.status >= 200 && init.status < 300, status = ok ? 200 : 500 } = init;
  return ({
    ok,
    status,
    json: async () => json,
  }) as unknown as Response & { json(): Promise<T> };
};
