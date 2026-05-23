import { describe, it, expect } from 'vitest';

import {
  buildCodexThreadOptions,
  mapPermissionModeToCodexOptions,
} from './codexOptionsBuilder.js';

describe('mapPermissionModeToCodexOptions', () => {
  it('default → workspace-write + untrusted', () => {
    expect(mapPermissionModeToCodexOptions('default')).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'untrusted',
    });
  });

  it('acceptEdits → workspace-write + never', () => {
    expect(mapPermissionModeToCodexOptions('acceptEdits')).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    });
  });

  it('bypassPermissions → danger-full-access + never', () => {
    expect(mapPermissionModeToCodexOptions('bypassPermissions')).toEqual({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
    });
  });

  it('plan → read-only + on-request', () => {
    expect(mapPermissionModeToCodexOptions('plan')).toEqual({
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
    });
  });

  it('unknown / undefined falls back to default mapping', () => {
    expect(mapPermissionModeToCodexOptions(undefined)).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'untrusted',
    });
  });
});

describe('buildCodexThreadOptions', () => {
  it('always sets skipGitRepoCheck=true and workingDirectory=cwd', () => {
    const opts = buildCodexThreadOptions({ cwd: '/work', prompt: 'hi', model: 'gpt-5.5', effort: null });
    expect(opts.workingDirectory).toBe('/work');
    expect(opts.skipGitRepoCheck).toBe(true);
  });

  it('passes through a valid OpenAI model and effort', () => {
    const opts = buildCodexThreadOptions({
      cwd: '/x',
      prompt: 'hi',
      model: 'gpt-5.5',
      effort: 'high',
    });
    expect(opts.model).toBe('gpt-5.5');
    expect(opts.modelReasoningEffort).toBe('high');
  });

  it('passes the model through verbatim (validation is upstream — no silent drop)', () => {
    // The model is gated by the create-conversation schema and the
    // agent-settings validator before it ever reaches here, so the builder
    // no longer second-guesses it. An effort that is not a valid OpenAI
    // effort is still dropped (it's a tuning knob, not the model identity).
    const opts = buildCodexThreadOptions({
      cwd: '/x',
      prompt: 'hi',
      model: 'gpt-5.5',
      effort: 'max',
    });
    expect(opts.model).toBe('gpt-5.5');
    expect(opts.modelReasoningEffort).toBeUndefined();
  });

  it('honours bypassPermissions mapping (D8 — Bottega default)', () => {
    const opts = buildCodexThreadOptions({
      cwd: '/x',
      prompt: 'hi',
      model: 'gpt-5.5',
      effort: null,
      permissionMode: 'bypassPermissions',
    });
    expect(opts.sandboxMode).toBe('danger-full-access');
    expect(opts.approvalPolicy).toBe('never');
  });
});
