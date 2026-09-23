/**
 * Tests for `nansen mcp install/uninstall` (src/commands/mcp.js).
 * House pattern: real temp dir + injected deps, no fs mocking.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  resolveClientConfigPath,
  buildServerEntry,
  mergeNansenEntry,
  removeNansenEntry,
  buildMcpCommands,
  NANSEN_MCP_URL,
  MCP_REMOTE_PIN,
  SUPPORTED_CLIENTS,
} from '../commands/mcp.js';

const API_KEY = 'test-key-123';
const EXPECTED_MCP_URL = 'https://mcp.nansen.ai/ra/mcp';
const EXPECTED_MCP_REMOTE_PIN = 'mcp-remote@0.2.1';
const EXPECTED_HEADER = 'NANSEN-API-KEY';
const EXPECTED_HEADER_PLACEHOLDER = 'NANSEN-API-KEY:${NANSEN_API_KEY}';

function validateGeneratedEntry(client, entry, apiKey = API_KEY) {
  const fail = message => { throw new Error(message); };
  const checkEndpoint = endpoint => {
    let parsed;
    try { parsed = new URL(endpoint); } catch { fail('malformed MCP endpoint'); }
    if (endpoint !== EXPECTED_MCP_URL
      || parsed.protocol !== 'https:'
      || parsed.hostname !== 'mcp.nansen.ai'
      || parsed.pathname !== '/ra/mcp'
      || parsed.search
      || parsed.hash) {
      fail('malformed MCP endpoint');
    }
  };

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('malformed MCP entry');

  if (client === 'claude-desktop') {
    if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(['args', 'command', 'env'])) fail('malformed MCP desktop entry');
    if (entry.command !== 'npx' || !Array.isArray(entry.args) || entry.args.length !== 5) fail('malformed MCP desktop args');
    checkEndpoint(entry.args[2]);
    if (entry.args[0] !== '-y' || entry.args[1] !== EXPECTED_MCP_REMOTE_PIN) fail('malformed MCP pin');
    if (entry.args[3] !== '--header') fail('malformed MCP header');
    if (entry.args[4] !== EXPECTED_HEADER_PLACEHOLDER) fail('malformed MCP placeholder');
    if (JSON.stringify(entry.env) !== JSON.stringify({ NANSEN_API_KEY: apiKey })
      || entry.args.includes(apiKey)
      || entry.args.includes('--allow-http')) {
      fail('malformed MCP credential placement');
    }
    return;
  }

  if (!SUPPORTED_CLIENTS.includes(client)) fail('unsupported MCP client');
  checkEndpoint(entry.url);
  const expected = client === 'claude-code'
    ? { type: 'http', url: EXPECTED_MCP_URL, headers: { [EXPECTED_HEADER]: apiKey } }
    : { url: EXPECTED_MCP_URL, headers: { [EXPECTED_HEADER]: apiKey } };
  if (JSON.stringify(entry) !== JSON.stringify(expected)) fail('malformed MCP header');
}

const README_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../README.md');

describe('resolveClientConfigPath', () => {
  const ctx = { platform: 'linux', homedir: '/home/u', env: {} };

  it('claude-code -> ~/.claude.json on all platforms', () => {
    expect(resolveClientConfigPath('claude-code', ctx)).toBe('/home/u/.claude.json');
    expect(resolveClientConfigPath('claude-code', { ...ctx, platform: 'darwin' })).toBe('/home/u/.claude.json');
    expect(resolveClientConfigPath('claude-code', { ...ctx, platform: 'win32' })).toBe(path.join('/home/u', '.claude.json'));
  });

  it('claude-code honors CLAUDE_CONFIG_DIR', () => {
    expect(resolveClientConfigPath('claude-code', { ...ctx, env: { CLAUDE_CONFIG_DIR: '/custom/claude' } }))
      .toBe(path.join('/custom/claude', '.claude.json'));
  });

  it('cursor -> ~/.cursor/mcp.json on all platforms', () => {
    for (const platform of ['linux', 'darwin', 'win32']) {
      expect(resolveClientConfigPath('cursor', { ...ctx, platform })).toBe(path.join('/home/u', '.cursor', 'mcp.json'));
    }
  });

  it('claude-desktop on macOS -> Application Support path', () => {
    expect(resolveClientConfigPath('claude-desktop', { ...ctx, platform: 'darwin' }))
      .toBe(path.join('/home/u', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  });

  it('claude-desktop on Windows uses APPDATA', () => {
    expect(resolveClientConfigPath('claude-desktop', { platform: 'win32', homedir: 'C:\\Users\\u', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' } }))
      .toBe(path.join('C:\\Users\\u\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json'));
  });

  it('claude-desktop on Linux throws with actionable message', () => {
    expect(() => resolveClientConfigPath('claude-desktop', ctx)).toThrow(/not available on Linux.*claude-code/s);
  });

  it('unknown client throws listing supported clients', () => {
    expect(() => resolveClientConfigPath('vscode', ctx)).toThrow(/claude-code, claude-desktop, cursor/);
  });
});

describe('buildServerEntry', () => {
  it.each(SUPPORTED_CLIENTS)('%s emits the exact supported artifact', client => {
    expect(NANSEN_MCP_URL).toBe(EXPECTED_MCP_URL);
    expect(MCP_REMOTE_PIN).toBe(EXPECTED_MCP_REMOTE_PIN);
    expect(() => validateGeneratedEntry(client, buildServerEntry(client, API_KEY))).not.toThrow();
  });

  it('rejects malformed endpoints, headers, and placeholders in generated entries', () => {
    for (const client of SUPPORTED_CLIENTS) {
      const entry = buildServerEntry(client, API_KEY);
      const malformedEndpoint = client === 'claude-desktop'
        ? { ...entry, args: [...entry.args.slice(0, 2), 'http://evil.example/mcp', ...entry.args.slice(3)] }
        : { ...entry, url: 'http://evil.example/mcp' };
      expect(() => validateGeneratedEntry(client, malformedEndpoint)).toThrow(/endpoint/);
      const malformedUrl = client === 'claude-desktop'
        ? { ...entry, args: [...entry.args.slice(0, 2), 'not a URL', ...entry.args.slice(3)] }
        : { ...entry, url: 'not a URL' };
      expect(() => validateGeneratedEntry(client, malformedUrl)).toThrow(/endpoint/);

      if (client === 'claude-desktop') {
        const malformedPlaceholder = { ...entry, args: [...entry.args.slice(0, 4), 'NANSEN-API-KEY:<your-key>'] };
        expect(() => validateGeneratedEntry(client, malformedPlaceholder)).toThrow(/placeholder/);
        const malformedHeader = { ...entry, args: [...entry.args.slice(0, 3), '--bad-header', entry.args[4]] };
        expect(() => validateGeneratedEntry(client, malformedHeader)).toThrow(/header/);
      } else {
        const malformedHeader = { ...entry, headers: { 'NANSEN-API-KEY': '' } };
        expect(() => validateGeneratedEntry(client, malformedHeader)).toThrow(/header/);
        const placeholderCredential = { ...entry, headers: { 'NANSEN-API-KEY': 'YOUR_API_KEY_HERE' } };
        expect(() => validateGeneratedEntry(client, placeholderCredential)).toThrow(/header/);
      }
    }
  });

  it('builds each artifact deterministically', () => {
    for (const client of SUPPORTED_CLIENTS) {
      expect(JSON.stringify(buildServerEntry(client, API_KEY)))
        .toBe(JSON.stringify(buildServerEntry(client, API_KEY)));
    }
  });
});

describe('MCP README onboarding contract', () => {
  it('keeps documented commands and bridge values aligned with generated entries', () => {
    const readme = fs.readFileSync(README_PATH, 'utf8');
    expect(readme).toContain(EXPECTED_MCP_URL);
    expect(readme).toContain(EXPECTED_HEADER);
    expect(readme).toContain(EXPECTED_HEADER_PLACEHOLDER);
    expect(readme).toContain(EXPECTED_MCP_REMOTE_PIN);

    for (const client of SUPPORTED_CLIENTS) {
      const entry = buildServerEntry(client, API_KEY);
      expect(readme).toContain(`nansen mcp install ${client}`);
      expect(readme).toContain(client === 'claude-desktop' ? entry.args[2] : entry.url);
    }
  });
});

describe('mergeNansenEntry / removeNansenEntry', () => {
  const entry = buildServerEntry('cursor', API_KEY);

  it('preserves sibling servers and unrelated top-level keys', () => {
    const cfg = { mcpServers: { other: { command: 'foo' } }, theme: 'dark' };
    const merged = mergeNansenEntry(cfg, entry);
    expect(merged.mcpServers.other).toEqual({ command: 'foo' });
    expect(merged.theme).toBe('dark');
    expect(merged.mcpServers.nansen).toEqual(entry);
    expect(cfg.mcpServers.nansen).toBeUndefined(); // input not mutated
  });

  it('creates mcpServers when absent and overwrites an existing nansen entry', () => {
    expect(mergeNansenEntry({}, entry).mcpServers.nansen).toEqual(entry);
    const merged = mergeNansenEntry({ mcpServers: { nansen: { url: 'old' } } }, entry);
    expect(merged.mcpServers.nansen).toEqual(entry);
  });

  it('refuses when mcpServers is not an object', () => {
    expect(() => mergeNansenEntry({ mcpServers: [] }, entry)).toThrow(/not an object/);
    expect(() => mergeNansenEntry({ mcpServers: 'nope' }, entry)).toThrow(/not an object/);
    expect(() => removeNansenEntry({ mcpServers: 42 })).toThrow(/not an object/);
  });

  it('refuses when the config root is not an object', () => {
    for (const config of [null, [], 'nope']) {
      expect(() => mergeNansenEntry(config, entry)).toThrow(/must contain a JSON object/);
      expect(() => removeNansenEntry(config)).toThrow(/must contain a JSON object/);
    }
  });

  it('removeNansenEntry removes only nansen and reports not-found', () => {
    const { config, removed } = removeNansenEntry({ mcpServers: { nansen: entry, other: { command: 'foo' } } });
    expect(removed).toBe(true);
    expect(config.mcpServers).toEqual({ other: { command: 'foo' } });
    expect(removeNansenEntry({}).removed).toBe(false);
    expect(removeNansenEntry({ mcpServers: {} }).removed).toBe(false);
  });
});

describe('mcp command handler', () => {
  let tempDir;
  let logs;
  let mcp;
  const api = { apiKey: API_KEY };

  const run = (args, { flags = {}, apiInstance = api } = {}) => mcp(args, apiInstance, flags, {});
  const cursorPath = () => path.join(tempDir, '.cursor', 'mcp.json');
  const readCursor = () => JSON.parse(fs.readFileSync(cursorPath(), 'utf8'));
  const clientPlatform = client => client === 'claude-desktop' ? 'darwin' : 'linux';
  const clientPath = client => resolveClientConfigPath(client, {
    platform: clientPlatform(client),
    homedir: tempDir,
    env: {},
  });
  const runClient = (client, args, { flags = {}, apiInstance = api } = {}) => buildMcpCommands({
    log: (...a) => logs.push(a.join(' ')),
    platform: clientPlatform(client),
    homedirFn: () => tempDir,
    env: {},
  }).mcp(args, apiInstance, flags, {});
  const readClient = client => JSON.parse(fs.readFileSync(clientPath(client), 'utf8'));

  beforeEach(() => {
    // realpath: on macOS os.tmpdir() is /var/... which is a symlink to
    // /private/var/..., and the command logs the resolved path.
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-mcp-test-')));
    logs = [];
    ({ mcp } = buildMcpCommands({
      log: (...a) => logs.push(a.join(' ')),
      platform: 'linux',
      homedirFn: () => tempDir,
      env: {},
    }));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('install creates dir 0700 and file 0600 with the nansen entry', async () => {
    await run(['install', 'cursor']);
    expect(readCursor().mcpServers.nansen).toEqual(buildServerEntry('cursor', API_KEY));
    expect(fs.statSync(path.dirname(cursorPath())).mode & 0o777).toBe(0o700);
    expect(fs.statSync(cursorPath()).mode & 0o777).toBe(0o600);
    expect(logs.join('\n')).toContain('Installed Nansen MCP server');
    expect(logs.join('\n')).toContain('plaintext');
  });

  it.each(SUPPORTED_CLIENTS)('install merges into an existing config and writes a backup first for %s', async client => {
    const configPath = clientPath(client);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const original = JSON.stringify({ mcpServers: { other: { command: 'foo' } }, unrelated: true });
    fs.writeFileSync(configPath, original);
    fs.writeFileSync(`${configPath}.bak`, 'older backup');

    await runClient(client, ['install', client]);

    const cfg = readClient(client);
    expect(cfg.mcpServers.other).toEqual({ command: 'foo' });
    expect(cfg.unrelated).toBe(true);
    expect(cfg.mcpServers.nansen).toEqual(buildServerEntry(client, API_KEY));
    expect(fs.readFileSync(`${configPath}.bak`, 'utf8')).toBe(original);
    expect(fs.statSync(`${configPath}.bak`).mode & 0o777).toBe(0o600);
    expect(logs.join('\n')).toContain(`Overwrote existing backup at ${configPath}.bak`);
  });

  it.each(SUPPORTED_CLIENTS)('re-running install is idempotent and reports an update for %s', async client => {
    await runClient(client, ['install', client]);
    logs.length = 0;
    await runClient(client, ['install', client]);
    expect(logs.join('\n')).toContain('Updated existing Nansen MCP entry');
    const entry = readClient(client).mcpServers.nansen;
    expect(entry).toEqual(buildServerEntry(client, API_KEY));
    expect(() => validateGeneratedEntry(client, entry)).not.toThrow();
  });

  it.each(SUPPORTED_CLIENTS)('refuses to touch unparseable JSON for %s', async client => {
    const configPath = clientPath(client);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{ not json');
    await expect(runClient(client, ['install', client])).rejects.toThrow(/Could not parse/);
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{ not json'); // untouched
    expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
  });

  it('reports config read failures without calling them parse errors', async () => {
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    fs.writeFileSync(cursorPath(), '{}');
    const readError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const { mcp: unreadableMcp } = buildMcpCommands({
      log: () => {},
      fsOverride: { ...fs, readFileSync: () => { throw readError; } },
      platform: 'linux',
      homedirFn: () => tempDir,
      env: {},
    });

    await expect(unreadableMcp(['install', 'cursor'], api, {}, {}))
      .rejects.toThrow(/Could not read.*permission denied/);
  });

  it('removes the secret temp file when the atomic rename fails', async () => {
    const { mcp: failingMcp } = buildMcpCommands({
      log: () => {},
      fsOverride: { ...fs, renameSync: () => { throw new Error('rename failed'); } },
      platform: 'linux',
      homedirFn: () => tempDir,
      env: {},
    });

    await expect(failingMcp(['install', 'cursor'], api, {}, {})).rejects.toThrow('rename failed');
    expect(fs.readdirSync(path.dirname(cursorPath()))).toEqual([]);
  });

  it('requires login and writes nothing without a key', async () => {
    await expect(run(['install', 'cursor'], { apiInstance: { apiKey: null } }))
      .rejects.toThrow('Not logged in. Run: nansen login');
    expect(fs.existsSync(cursorPath())).toBe(false);
  });

  it('--dry-run writes nothing and never prints the key', async () => {
    await run(['install', 'cursor'], { flags: { 'dry-run': true } });
    expect(fs.existsSync(cursorPath())).toBe(false);
    const out = logs.join('\n');
    expect(out).toContain(cursorPath());
    expect(out).toContain('<redacted>');
    expect(out).not.toContain(API_KEY);
  });

  it('install --dry-run validates existing JSON without modifying it', async () => {
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    fs.writeFileSync(cursorPath(), '{ not json');
    await expect(run(['install', 'cursor'], { flags: { 'dry-run': true } })).rejects.toThrow(/Could not parse/);
    expect(fs.readFileSync(cursorPath(), 'utf8')).toBe('{ not json');
    expect(fs.existsSync(`${cursorPath()}.bak`)).toBe(false);
  });

  it('install output never contains the key', async () => {
    await run(['install', 'cursor']);
    expect(logs.join('\n')).not.toContain(API_KEY);
  });

  it('uninstall removes only the nansen entry', async () => {
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    fs.writeFileSync(cursorPath(), JSON.stringify({ mcpServers: { nansen: { url: 'x' }, other: { command: 'foo' } } }));
    await run(['uninstall', 'cursor']);
    expect(readCursor().mcpServers).toEqual({ other: { command: 'foo' } });
  });

  it('uninstall --dry-run does not throw on an unparseable config', async () => {
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    fs.writeFileSync(cursorPath(), '{ not valid json,,,', 'utf8');
    await run(['uninstall', 'cursor'], { flags: { 'dry-run': true } });
    expect(logs.join('\n')).toContain('Cannot preview');
    expect(logs.join('\n')).toContain('No changes made.');
    // the file is untouched
    expect(fs.readFileSync(cursorPath(), 'utf8')).toBe('{ not valid json,,,');
  });

  it('uninstall without --dry-run still fails loudly on an unparseable config', async () => {
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    fs.writeFileSync(cursorPath(), '{ not valid json,,,', 'utf8');
    await expect(run(['uninstall', 'cursor'])).rejects.toThrow(/parse/i);
  });

  it('uninstall backs up the config before writing (0600)', async () => {
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    const original = JSON.stringify({ mcpServers: { nansen: { url: 'x' }, other: { command: 'foo' } } });
    fs.writeFileSync(cursorPath(), original);

    await run(['uninstall', 'cursor']);

    expect(fs.readFileSync(`${cursorPath()}.bak`, 'utf8')).toBe(original);
    expect(fs.statSync(`${cursorPath()}.bak`).mode & 0o777).toBe(0o600);
    expect(logs.join('\n')).toContain(`Backed up existing config to ${cursorPath()}.bak`);
    // The backup carries the key that was just removed — say so, but never print it.
    expect(logs.join('\n')).toContain(`${cursorPath()}.bak still contains your API key`);
    expect(logs.join('\n')).not.toContain(API_KEY);
  });

  it('uninstall writes no backup when there is nothing to remove', async () => {
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    fs.writeFileSync(cursorPath(), JSON.stringify({ mcpServers: { other: { command: 'foo' } } }));

    await run(['uninstall', 'cursor']);
    expect(fs.existsSync(`${cursorPath()}.bak`)).toBe(false);

    await run(['uninstall', 'cursor'], { flags: { 'dry-run': true } });
    expect(fs.existsSync(`${cursorPath()}.bak`)).toBe(false);
  });

  it('uninstall surfaces a failed backup copy instead of writing the config', async () => {
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    const original = JSON.stringify({ mcpServers: { nansen: { url: 'x' } } });
    fs.writeFileSync(cursorPath(), original);
    const { mcp: failingMcp } = buildMcpCommands({
      log: () => {},
      fsOverride: { ...fs, copyFileSync: () => { throw new Error('copy failed'); } },
      platform: 'linux',
      homedirFn: () => tempDir,
      env: {},
    });

    await expect(failingMcp(['uninstall', 'cursor'], api, {}, {})).rejects.toThrow('copy failed');
    expect(fs.readFileSync(cursorPath(), 'utf8')).toBe(original);
  });

  it('uninstall --dry-run leaves the config unchanged', async () => {
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    const original = JSON.stringify({ mcpServers: { nansen: { url: 'x' } } });
    fs.writeFileSync(cursorPath(), original);
    await run(['uninstall', 'cursor'], { flags: { 'dry-run': true } });
    expect(fs.readFileSync(cursorPath(), 'utf8')).toBe(original);
    expect(logs.join('\n')).toContain('Would remove "nansen" entry');
  });

  it('uninstall with no entry is a friendly no-op', async () => {
    await run(['uninstall', 'cursor']);
    expect(logs.join('\n')).toContain('Nothing to do');
  });

  it('uninstall works without an API key', async () => {
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    fs.writeFileSync(cursorPath(), JSON.stringify({ mcpServers: { nansen: { url: 'x' } } }));
    await run(['uninstall', 'cursor'], { apiInstance: { apiKey: null } });
    expect(readCursor().mcpServers).toEqual({});
  });

  it('bare `mcp` and `mcp --help` print usage; bad inputs throw actionable errors', async () => {
    await run([]);
    expect(logs.join('\n')).toContain('nansen mcp install <client>');
    await expect(run(['frobnicate'])).rejects.toThrow(/Unknown subcommand/);
    await expect(run(['install'])).rejects.toThrow(/claude-code, claude-desktop, cursor/);
    await expect(run(['install', 'vscode'])).rejects.toThrow(/claude-code, claude-desktop, cursor/);
    await expect(run(['uninstall'])).rejects.toThrow(/nansen mcp uninstall <client>/);
    await expect(run(['uninstall', 'vscode'])).rejects.toThrow(/nansen mcp uninstall <client>/);
  });

  it('follows a symlinked config instead of replacing the link', async () => {
    const realDir = path.join(tempDir, 'dotfiles');
    fs.mkdirSync(realDir, { recursive: true });
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    const realFile = path.join(realDir, 'mcp.json');
    fs.writeFileSync(realFile, '{}');
    fs.symlinkSync(realFile, cursorPath());

    await run(['install', 'cursor']);

    expect(fs.lstatSync(cursorPath()).isSymbolicLink()).toBe(true); // link survives
    expect(JSON.parse(fs.readFileSync(realFile, 'utf8')).mcpServers.nansen.url).toBe(NANSEN_MCP_URL);
  });

  it('resolves a symlinked parent when installing a fresh config', async () => {
    const realDir = path.join(tempDir, 'dotfiles', 'cursor');
    fs.mkdirSync(realDir, { recursive: true });
    fs.symlinkSync(realDir, path.join(tempDir, '.cursor'));

    await run(['install', 'cursor']);

    const realFile = path.join(realDir, 'mcp.json');
    expect(JSON.parse(fs.readFileSync(realFile, 'utf8')).mcpServers.nansen.url).toBe(NANSEN_MCP_URL);
    expect(logs.join('\n')).toContain(realFile);
  });
});

describe('schema + CLI registration', () => {
  it('schema.json documents mcp install/uninstall/verify', async () => {
    const { fileURLToPath } = await import('url');
    const schema = JSON.parse(fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schema.json'), 'utf8'));
    expect(Object.keys(schema.commands)).toContain('mcp');
    expect(Object.keys(schema.commands.mcp.subcommands).sort()).toEqual(['install', 'uninstall', 'verify']);
    expect(schema.commands.mcp.subcommands.uninstall.options['dry-run'].type).toBe('boolean');
  });

  it('generated mcp help uses examples with the required client', async () => {
    const { generateSubcommandHelp } = await import('../cli.js');
    expect(generateSubcommandHelp('mcp', 'install')).toContain('Example: nansen mcp install claude-code');
    expect(generateSubcommandHelp('mcp', 'uninstall')).toContain('Example: nansen mcp uninstall claude-code');
  });

  it('runCLI routes `mcp` and parses --dry-run as a boolean flag', async () => {
    const { runCLI, parseArgs } = await import('../cli.js');
    expect(parseArgs(['mcp', 'install', '--dry-run', 'cursor'])._).toEqual(['mcp', 'install', 'cursor']);

    const outputs = [];
    const logs = [];
    const result = await runCLI(['mcp'], {
      output: (m) => outputs.push(m),
      log: (m) => logs.push(m),
      errorOutput: () => {},
      exit: () => {},
    });
    expect(result.type).toBe('no-output');
    expect(logs.join('\n')).toContain('nansen mcp install <client>');
  });

  it('runCLI routes mcp output through the caller\'s output sink', async () => {
    const { runCLI } = await import('../cli.js');
    const outputs = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await runCLI(['mcp'], {
        output: (m) => outputs.push(m),
        errorOutput: () => {},
        exit: () => {},
      });
      expect(result.type).toBe('no-output');
      expect(outputs.join('\n')).toContain('nansen mcp install <client>');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
