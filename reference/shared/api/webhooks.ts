// Request/response shapes for /api/webhooks/*.
//
// The GitHub webhook receives raw bodies (HMAC validation precedes JSON
// parse), so the request body is opaque from the route's perspective —
// we don't type the inbound shape here. Outbound responses follow the
// "always 200, status field tells caller what happened" pattern that
// keeps GitHub from retrying on expected rejections.

import { expectType } from './_common';

// ---- POST /api/webhooks/github -------------------------------------------

export interface WebhookTriggeredResponse {
  status: 'triggered';
  taskId: number;
  conversationId: number;
}

export interface WebhookIgnoredResponse {
  status: 'ignored';
  // Specific reason. Common values include:
  //   - 'no @bottega mention'
  //   - 'could not determine branch'
  //   - 'branch not in task format'
  //   - 'task not found' / 'already completed' / 'already running'
  //   - `not a ${expectedAction} event`
  //   - `not a PR comment`
  reason?: string;
  // Some early branches return only `{ status: 'ignored', event }`.
  event?: string;
}

export type GitHubWebhookResponse =
  | WebhookTriggeredResponse
  | WebhookIgnoredResponse;

// 500 body for unexpected trigger failures.
export interface WebhookErrorResponse {
  error: 'Failed to trigger agent';
  message: string;
}

// ---- GET /api/webhooks/health --------------------------------------------

export interface WebhookHealthResponse {
  status: 'ok';
  webhookSecretConfigured: boolean;
}

// ---- Type-level smoke checks ---------------------------------------------

expectType<GitHubWebhookResponse>({
  status: 'triggered',
  taskId: 0,
  conversationId: 0,
});
expectType<GitHubWebhookResponse>({ status: 'ignored' });
