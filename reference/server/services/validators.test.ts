import { describe, it, expect } from 'vitest';
import {
  assertAbsolutePath,
  assertValidBranchName,
  assertValidPort,
  assertValidPositiveInt,
  assertValidRepoFullName,
  assertValidServiceName,
  ValidationError,
} from './validators.js';

describe('assertValidBranchName', () => {
  for (const ok of ['main', 'master', 'feature/foo', 'task/15-add-login', 'v1.2.3', 'develop']) {
    it(`accepts ${JSON.stringify(ok)}`, () => {
      expect(assertValidBranchName(ok)).toBe(ok);
    });
  }

  for (const bad of [
    '',
    '-flag-like-branch',
    'has space',
    'has;semicolon',
    'has$(cmd)',
    'has`backtick`',
    'has..traversal',
    '/leading-slash',
    'has\nnewline',
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => assertValidBranchName(bad)).toThrow(ValidationError);
    });
  }
});

describe('assertValidServiceName', () => {
  for (const ok of ['puma@my-project', 'foo_bar', 'simple', 'a1b2c3']) {
    it(`accepts ${JSON.stringify(ok)}`, () => {
      expect(assertValidServiceName(ok)).toBe(ok);
    });
  }

  for (const bad of ['', 'has space', 'evil; rm -rf /', 'with.dot', '../../etc']) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => assertValidServiceName(bad)).toThrow(ValidationError);
    });
  }
});

describe('assertValidPort', () => {
  for (const ok of [1, 80, 443, 65535, '3002']) {
    it(`accepts ${JSON.stringify(ok)}`, () => {
      expect(assertValidPort(ok)).toBeGreaterThan(0);
    });
  }

  for (const bad of [0, -1, 65536, 99999999, 1.5, NaN, 'not-a-number', '']) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => assertValidPort(bad as number)).toThrow(ValidationError);
    });
  }
});

describe('assertValidRepoFullName', () => {
  for (const ok of ['org/repo', 'octocat/Hello-World', 'a.b/c_d-e']) {
    it(`accepts ${JSON.stringify(ok)}`, () => {
      expect(assertValidRepoFullName(ok)).toBe(ok);
    });
  }

  for (const bad of ['no-slash', 'too/many/slashes', 'evil;rm/repo', 'org/$(id)', '']) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => assertValidRepoFullName(bad)).toThrow(ValidationError);
    });
  }
});

describe('assertValidPositiveInt', () => {
  it('accepts positive integers', () => {
    expect(assertValidPositiveInt(1)).toBe(1);
    expect(assertValidPositiveInt(999999)).toBe(999999);
  });

  for (const bad of [0, -1, 1.5, NaN, Infinity]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => assertValidPositiveInt(bad)).toThrow(ValidationError);
    });
  }
});

describe('assertAbsolutePath', () => {
  for (const ok of ['/', '/var/www/app', '/home/user/repo']) {
    it(`accepts ${JSON.stringify(ok)}`, () => {
      expect(assertAbsolutePath(ok)).toBe(ok);
    });
  }

  for (const bad of ['', 'relative/path', './still-relative', '/contains/../traversal', '/has\0nul']) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => assertAbsolutePath(bad)).toThrow(ValidationError);
    });
  }
});
