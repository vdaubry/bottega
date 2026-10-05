import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { loadEnabledPlugins, resolveOperatorClaudeConfigDir } from './pluginConfig.js';

describe('loadEnabledPlugins — operator plugins for every SDK turn', () => {
  let configDir: string;
  let figmaDir: string;

  function writeJson(relative: string, value: unknown): void {
    const file = path.join(configDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  }

  function writeInstalled(plugins: Record<string, unknown>): void {
    writeJson('plugins/installed_plugins.json', { version: 2, plugins });
  }

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-plugin-config-'));
    figmaDir = path.join(configDir, 'plugins', 'cache', 'official', 'figma', '2.2.96');
    fs.mkdirSync(figmaDir, { recursive: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('returns the enabled, installed plugins as SDK local-plugin entries', async () => {
    writeJson('settings.json', { enabledPlugins: { 'figma@official': true } });
    writeInstalled({
      'figma@official': [{ scope: 'user', installPath: figmaDir, version: '2.2.96' }],
    });

    await expect(loadEnabledPlugins(configDir)).resolves.toEqual([
      { type: 'local', path: figmaDir },
    ]);
  });

  it('returns nothing when the operator has no settings file', async () => {
    await expect(loadEnabledPlugins(configDir)).resolves.toEqual([]);
  });

  it('returns nothing when no plugin is enabled', async () => {
    writeJson('settings.json', { model: 'opus' });
    writeInstalled({ 'figma@official': [{ scope: 'user', installPath: figmaDir }] });

    await expect(loadEnabledPlugins(configDir)).resolves.toEqual([]);
  });

  it('skips a plugin that is enabled but not installed', async () => {
    writeJson('settings.json', { enabledPlugins: { 'figma@official': true, 'ghost@official': true } });
    writeInstalled({ 'figma@official': [{ scope: 'user', installPath: figmaDir }] });

    await expect(loadEnabledPlugins(configDir)).resolves.toEqual([
      { type: 'local', path: figmaDir },
    ]);
  });

  it('skips a plugin that is installed but disabled, and one not mentioned at all', async () => {
    const ralphDir = path.join(configDir, 'plugins', 'cache', 'official', 'ralph', '1.0.0');
    fs.mkdirSync(ralphDir, { recursive: true });
    writeJson('settings.json', { enabledPlugins: { 'figma@official': true, 'ralph@official': false } });
    writeInstalled({
      'figma@official': [{ scope: 'user', installPath: figmaDir }],
      'ralph@official': [{ scope: 'user', installPath: ralphDir }],
      'other@official': [{ scope: 'user', installPath: figmaDir }],
    });

    await expect(loadEnabledPlugins(configDir)).resolves.toEqual([
      { type: 'local', path: figmaDir },
    ]);
  });

  it('skips an install path that no longer exists on disk (plugin cache pruned)', async () => {
    writeJson('settings.json', { enabledPlugins: { 'figma@official': true } });
    writeInstalled({
      'figma@official': [{ scope: 'user', installPath: path.join(configDir, 'gone') }],
    });

    await expect(loadEnabledPlugins(configDir)).resolves.toEqual([]);
  });

  it('prefers the user-scope install record over other scopes', async () => {
    const projectDir = path.join(configDir, 'plugins', 'cache', 'official', 'figma', 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    writeJson('settings.json', { enabledPlugins: { 'figma@official': true } });
    writeInstalled({
      'figma@official': [
        { scope: 'project', installPath: projectDir },
        { scope: 'user', installPath: figmaDir },
      ],
    });

    await expect(loadEnabledPlugins(configDir)).resolves.toEqual([
      { type: 'local', path: figmaDir },
    ]);
  });

  it('accepts the older single-record installed_plugins shape', async () => {
    writeJson('settings.json', { enabledPlugins: { 'figma@official': true } });
    writeInstalled({ 'figma@official': { installPath: figmaDir, version: '2.2.91' } });

    await expect(loadEnabledPlugins(configDir)).resolves.toEqual([
      { type: 'local', path: figmaDir },
    ]);
  });

  it('orders entries by plugin name so the CLI args are deterministic', async () => {
    const aDir = path.join(configDir, 'plugins', 'cache', 'official', 'a', '1');
    fs.mkdirSync(aDir, { recursive: true });
    writeJson('settings.json', { enabledPlugins: { 'zeta@official': true, 'alpha@official': true } });
    writeInstalled({
      'zeta@official': [{ scope: 'user', installPath: figmaDir }],
      'alpha@official': [{ scope: 'user', installPath: aDir }],
    });

    await expect(loadEnabledPlugins(configDir)).resolves.toEqual([
      { type: 'local', path: aDir },
      { type: 'local', path: figmaDir },
    ]);
  });

  it('fails open to no plugins on a malformed file, and logs', async () => {
    fs.writeFileSync(path.join(configDir, 'settings.json'), '{ not json');

    await expect(loadEnabledPlugins(configDir)).resolves.toEqual([]);
    expect(console.error).toHaveBeenCalledWith(
      '[ConversationAdapter] Error loading operator plugins:',
      expect.any(String),
    );
  });

  it('resolves the operator config dir from CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = '/custom/claude';
      expect(resolveOperatorClaudeConfigDir()).toBe('/custom/claude');
      delete process.env.CLAUDE_CONFIG_DIR;
      expect(resolveOperatorClaudeConfigDir()).toBe(path.join(os.homedir(), '.claude'));
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });
});
