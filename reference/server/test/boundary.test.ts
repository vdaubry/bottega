import { describe, it, expect } from 'vitest';
import { readdirSync } from 'fs';
import { join } from 'path';
import eslintConfig from '../../eslint.config.js';

// The architecture-v2 layering rules (docs/epics/architecture-v2.md) live in
// eslint.config.ts as three no-restricted-imports zones. Lint enforces the
// rules; this test enforces the lint config itself — so a new task-layer
// module can't silently escape the boundary because nobody added it to the
// restriction lists.

interface RestrictedPattern {
  group: string[];
  message: string;
}

interface Zone {
  files?: string[];
  ignores?: string[];
  rules?: Record<string, unknown>;
}

const zones = (eslintConfig as Zone[]).filter(
  (entry) => entry.rules && 'no-restricted-imports' in entry.rules,
);

function zoneFor(filesPattern: string): Zone {
  const zone = zones.find((z) => z.files?.length === 1 && z.files[0] === filesPattern);
  if (!zone) throw new Error(`no boundary zone with files: ['${filesPattern}']`);
  return zone;
}

function restrictedGroups(zone: Zone): string[] {
  const rule = zone.rules!['no-restricted-imports'] as [string, { patterns: RestrictedPattern[] }];
  return rule[1].patterns.flatMap((p) => p.group);
}

// A specifier like '../tasks/adapter.js' is caught by a group entry like
// '**/tasks/adapter.js' — coverage here means some group entry ends with the
// module's path (both extensionless and .js forms must be present, since
// no-restricted-imports matches the literal specifier).
function covers(groups: string[], modulePath: string): boolean {
  return (
    groups.some((g) => g === `**/${modulePath}` || g.endsWith(`/${modulePath}`)) &&
    groups.some((g) => g === `**/${modulePath}.js` || g.endsWith(`/${modulePath}.js`))
  );
}

const tasksDir = join(import.meta.dirname, '../services/tasks');
const taskLayerModules = readdirSync(tasksDir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => f.replace(/\.ts$/, ''));

describe('architecture-v2 boundary lint config', () => {
  it('defines the three boundary zones', () => {
    expect(zoneFor('server/**/*.ts')).toBeDefined();
    expect(zoneFor('server/services/epics/**/*.ts')).toBeDefined();
    expect(zoneFor('server/services/conversation/**/*.ts')).toBeDefined();
  });

  it('rule 1: only the documented adapters may import the epic layer', () => {
    const zone = zoneFor('server/**/*.ts');
    // The complete allowlist. Adding an importer of the epic layer means
    // consciously extending this list in BOTH places.
    expect(zone.ignores).toEqual([
      'server/services/epics/**',
      'server/routes/epics.ts',
      // The inbound GitHub half: a comment on the epic's final pull request
      // starts its delivery agent (docs/epics/delivery.md).
      'server/routes/webhooks.ts',
      'server/websocket/dispatch.ts',
      'server/index.ts',
      'server/database/epics.ts',
      'server/database/epicConversion.ts',
      '**/*.test.ts',
      'server/test/**',
    ]);
    const groups = restrictedGroups(zone);
    expect(groups).toContain('**/services/epics/**');
    expect(covers(groups, 'database/epics')).toBe(true);
  });

  it('rule 2: the epic layer is walled off from every task-internal module', () => {
    const groups = restrictedGroups(zoneFor('server/services/epics/**/*.ts'));
    expect(covers(groups, 'database/tasks')).toBe(true);
    // Every module in server/services/tasks/ except the facade itself and the
    // published event contract must be restricted. This is the assertion that
    // keeps the list in sync with the directory: add tasks/foo.ts and this
    // test fails until eslint.config.ts restricts it.
    const published = ['index', 'events'];
    for (const mod of taskLayerModules.filter((m) => !published.includes(m))) {
      expect(covers(groups, `tasks/${mod}`), `tasks/${mod} must be restricted for the epic layer`).toBe(true);
    }
    // Task-domain service files living outside services/tasks/.
    expect(covers(groups, 'taskService')).toBe(true);
    expect(covers(groups, 'agentRunner')).toBe(true);
  });

  it('rule 3: the conversation runtime is walled off from both domains', () => {
    const groups = restrictedGroups(zoneFor('server/services/conversation/**/*.ts'));
    expect(groups).toContain('**/services/epics/**');
    expect(covers(groups, 'database/epics')).toBe(true);
    expect(covers(groups, 'database/tasks')).toBe(true);
    // The runtime may not even use the facade or the event bus — every
    // task-layer module including index and events is restricted here.
    for (const mod of taskLayerModules) {
      expect(covers(groups, `tasks/${mod}`), `tasks/${mod} must be restricted for the runtime`).toBe(true);
    }
    expect(covers(groups, 'taskService')).toBe(true);
  });
});
