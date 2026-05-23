// Typed REST contracts for /api/opencode-auth/*.

export interface OpenCodeAuthStatusResponse {
  authenticated: boolean;
  status: 'authenticated' | 'missing';
  /** On-disk path to the per-user auth.json (advisory; not for the UI to read). */
  authPath: string;
  /** Last-6 of the API key when present, null when missing. */
  tokenFingerprint: string | null;
  /** Failure reason when not authenticated. */
  reason: string | null;
}

export interface SetOpenCodeKeyResponse {
  authenticated: true;
  status: 'authenticated';
  tokenFingerprint: string;
}

export interface ClearOpenCodeKeyResponse {
  cleared: boolean;
}

/** A single Zen model row, as surfaced to the settings UI. */
export interface OpenCodeModelEntry {
  /** Bottega-persisted form: `opencode/<bareModelID>`. */
  id: string;
  /** Bare modelID without the `opencode/` prefix (what OpenCode itself stores). */
  bareModelId: string;
  /** Human-readable label, e.g. "Kimi K2.6". */
  name: string;
  /** Upstream lifecycle marker — `'deprecated'` rows can be greyed but still selectable. */
  status: 'alpha' | 'beta' | 'deprecated' | 'active' | 'unknown';
  /** Context window in tokens, or null when OpenCode didn't report one. */
  contextWindow: number | null;
}

/** Response of `GET /api/opencode-auth/models`. */
export interface OpenCodeModelsResponse {
  /** Live Zen catalog for the calling user (alpha-sorted). Empty when
   * the user has no Zen credentials configured. */
  models: OpenCodeModelEntry[];
}
