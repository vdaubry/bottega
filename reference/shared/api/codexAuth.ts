// Typed REST contracts for /api/codex-auth/*.

export interface CodexAuthStatusResponse {
  authenticated: boolean;
  status: 'authenticated' | 'missing';
  method: 'oauth' | 'api_key' | null;
  email: string | null;
  tokenFingerprint: string | null;
  reason: string | null;
  /** Active device-auth login (when one is in flight). */
  login: {
    active: true;
    loginSessionId: string;
    authUrl: string | null;
    deviceCode: string | null;
    startedAt: string;
    expiresAt: string;
  } | null;
}

export interface StartCodexAuthResponse {
  loginSessionId: string;
  authUrl: string | null;
  deviceCode: string | null;
  startedAt: string;
  expiresAt: string;
}

export interface CancelCodexAuthResponse {
  cancelled: boolean;
}

export interface PasteCodexAuthResponse {
  authenticated: true;
  status: 'authenticated';
  method: 'oauth' | 'api_key';
  tokenFingerprint: string;
}

export interface ClearCodexAuthResponse {
  cleared: boolean;
}
