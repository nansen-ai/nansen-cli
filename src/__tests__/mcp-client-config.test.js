/**
 * Tests for the canonical MCP client install config (API-322):
 * src/mcp-client-config.js, scripts/generate-mcp-docs.js and
 * scripts/check-mcp-remote-pin.js.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { createHash } from 'crypto';
import {
  MCP_CLIENT_CONFIG,
  MCP_CLIENT_CONFIG_PATH,
  buildStdioEntry,
  validateMcpClientConfig,
} from '../mcp-client-config.js';
import { buildServerEntry, NANSEN_MCP_URL, MCP_REMOTE_PIN } from '../commands/mcp.js';
import { DEFAULT_MCP_URL } from '../mcp-verify.js';
import {
  README_PATH,
  checkReadme,
  generateReadme,
  renderTemplate,
  replaceRegion,
} from '../../scripts/generate-mcp-docs.js';
import { run as runConsumerCheck } from '../../scripts/check-mcp-consumers.js';
import { EXIT, evaluatePin, formatReport, normalizeRepository, run as runPinCheck } from '../../scripts/check-mcp-remote-pin.js';

const RAW = JSON.parse(fs.readFileSync(MCP_CLIENT_CONFIG_PATH, 'utf8'));
const readme = () => fs.readFileSync(README_PATH, 'utf8');
const withChange = (change) => ({ ...structuredClone(RAW), ...change });

describe('canonical MCP client config', () => {
  it('is valid and is the only source the CLI reads', () => {
    expect(() => validateMcpClientConfig(RAW)).not.toThrow();
    expect(NANSEN_MCP_URL).toBe(RAW.endpoint);
    expect(DEFAULT_MCP_URL).toBe(RAW.endpoint);
    expect(MCP_REMOTE_PIN).toBe(`mcp-remote@${RAW.mcpRemote.version}`);
    expect(Object.isFrozen(MCP_CLIENT_CONFIG)).toBe(true);
  });

  it('keeps the value-carrying sources free of stray literals', () => {
    for (const file of ['../commands/mcp.js', '../mcp-verify.js']) {
      const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(src, file).not.toMatch(/["'`]https:\/\/mcp\.nansen\.ai/);
      expect(src, file).not.toMatch(/["'`]mcp-remote@/);
      expect(src, file).not.toMatch(/https:\/\/app\.nansen\.ai/);
    }
  });

  it('matches the endpoint documented in src/schema.json', () => {
    const schema = JSON.parse(fs.readFileSync(new URL('../schema.json', import.meta.url), 'utf8'));
    const mcp = schema.commands.mcp;
    expect(mcp.description).toContain(`(${RAW.endpoint})`);
    expect(mcp.subcommands.verify.options.url.default).toBe(RAW.endpoint);
  });

  it.each([
    ['http endpoint', { endpoint: 'http://mcp.nansen.ai/ra/mcp' }, /must use https/],
    ['trailing slash', { endpoint: 'https://mcp.nansen.ai/ra/mcp/' }, /must not end with/],
    ['other host', { endpoint: 'https://mcp.evil.example/ra/mcp' }, /must be on mcp\.nansen\.ai/],
    ['look-alike host', { endpoint: 'https://mcp.nansen.ai.evil.example/ra/mcp' }, /must be on mcp\.nansen\.ai/],
    ['query', { endpoint: 'https://mcp.nansen.ai/ra/mcp?x=1' }, /must not contain a query/],
    ['credentials', { endpoint: 'https://u:p@mcp.nansen.ai/ra/mcp' }, /must not contain credentials/],
    ['port', { endpoint: 'https://mcp.nansen.ai:8443/ra/mcp' }, /must not set a port/],
    ['same endpoints', { oauthEndpoint: RAW.endpoint }, /must differ/],
    ['range pin', { mcpRemote: { package: 'mcp-remote', version: '^0.2.1' } }, /exact x\.y\.z/],
    ['dist-tag pin', { mcpRemote: { package: 'mcp-remote', version: 'latest' } }, /exact x\.y\.z/],
    ['prerelease pin', { mcpRemote: { package: 'mcp-remote', version: '0.3.0-beta.1' } }, /exact x\.y\.z/],
    ['other bridge', { mcpRemote: { package: 'mcp-proxy', version: '1.0.0' } }, /must be "mcp-remote"/],
    ['bad header', { apiKeyHeader: 'NANSEN API KEY' }, /apiKeyHeader/],
    ['bad env var', { apiKeyEnvVar: 'nansen-key' }, /apiKeyEnvVar/],
    ['env var that shadows PATH', { apiKeyEnvVar: 'PATH' }, /NANSEN_/],
    ['shell metacharacter in endpoint', { endpoint: 'https://mcp.nansen.ai/ra/$(id)' }, /unsafe in docs or shell/],
    ['quote in endpoint', { endpoint: "https://mcp.nansen.ai/ra/mcp'x" }, /unsafe in docs or shell/],
    ['odd path characters', { endpoint: 'https://mcp.nansen.ai/ra/m%20cp' }, /path must match/],
    ['paren in link url', { apiKeySetupUrl: 'https://app.nansen.ai/a)b' }, /unsafe in docs or shell/],
    ['foreign dxt repo', { dxtDownloadUrl: 'https://github.com/evil/x/raw/main/nansen.dxt' }, /nansen-mcp-dxt/],
    ['bad server key', { serverKey: 'Nansen MCP' }, /serverKey/],
    ['http key url', { apiKeyManageUrl: 'http://app.nansen.ai/api?tab=api' }, /must use https/],
    ['unknown key', { mcpRemotePin: '0.2.1' }, /unknown key/],
    ['padded value', { serverKey: ' nansen' }, /surrounding whitespace/],
  ])('rejects %s', (_name, change, message) => {
    expect(() => validateMcpClientConfig(withChange(change))).toThrow(message);
  });

  it('rejects a missing field and a non-object', () => {
    const { apiKeyHeader: _dropped, ...missing } = RAW;
    expect(() => validateMcpClientConfig(missing)).toThrow(/apiKeyHeader/);
    expect(() => validateMcpClientConfig([])).toThrow(/JSON object/);
  });

  it('builds the stdio bridge entry from the raw config values', () => {
    const expected = {
      command: 'npx',
      args: ['-y', `mcp-remote@${RAW.mcpRemote.version}`, RAW.endpoint, '--header', `${RAW.apiKeyHeader}:\${${RAW.apiKeyEnvVar}}`],
      env: { [RAW.apiKeyEnvVar]: 'k' },
    };
    expect(buildStdioEntry('k')).toEqual(expected);
    expect(buildServerEntry('claude-desktop', 'k')).toEqual(expected);
  });
});

describe('README generator (npm run mcp:generate)', () => {
  it('README.md is up to date with the canonical config', () => {
    expect(checkReadme(readme())).toBe('');
  });

  it('is deterministic: a second run changes nothing', () => {
    const once = generateReadme(readme());
    expect(generateReadme(once)).toBe(once);
    expect(generateReadme(readme())).toBe(once);
  });

  it('fails the check with a fix hint when the generated region is edited by hand', () => {
    const edited = readme().replace(`mcp-remote@${RAW.mcpRemote.version}`, 'mcp-remote@0.1.38');
    expect(edited).not.toBe(readme());
    const message = checkReadme(edited);
    expect(message).toMatch(/README\.md MCP section is out of date/);
    expect(message).toMatch(/first difference at README\.md line \d+/);
    expect(message).toContain('npm run mcp:generate');
  });

  it('updates every value in the region when the canonical config changes', () => {
    const config = validateMcpClientConfig(withChange({
      endpoint: 'https://mcp.nansen.ai/ra/v2/mcp',
      mcpRemote: { package: 'mcp-remote', version: '9.8.7' },
    }));
    const generated = generateReadme(readme(), { config });
    const region = generated.slice(generated.indexOf('<!-- BEGIN GENERATED: mcp'), generated.indexOf('<!-- END GENERATED: mcp -->'));
    expect(region).toContain('mcp-remote@9.8.7');
    expect(region).not.toContain(`mcp-remote@${RAW.mcpRemote.version}`);
    expect(region).not.toContain(`${RAW.endpoint}\``);
    expect(region.split('https://mcp.nansen.ai/ra/v2/mcp').length - 1).toBeGreaterThanOrEqual(6);
    // Outside the region nothing changes.
    expect(generated.slice(0, generated.indexOf('<!-- BEGIN GENERATED: mcp'))).toBe(readme().slice(0, readme().indexOf('<!-- BEGIN GENERATED: mcp')));
  });

  it('renders JSON snippets that parse to the entries install writes', () => {
    const region = readme().slice(readme().indexOf('<!-- BEGIN GENERATED: mcp'), readme().indexOf('<!-- END GENERATED: mcp -->'));
    const blocks = [...region.matchAll(/```json\n([\s\S]*?)```/g)].map(match => JSON.parse(match[1]));
    expect(blocks).toEqual([
      { mcpServers: { nansen: buildServerEntry('cursor', '<your-key>') } },
      { mcpServers: { nansen: buildServerEntry('claude-desktop', '<your-key>') } },
    ]);
  });

  it('keeps working when the BEGIN marker hint text changes, and rewrites it', () => {
    const current = readme();
    const oldHint = current.replace(/<!-- BEGIN GENERATED: mcp\.[^\n]*-->/, '<!-- BEGIN GENERATED: mcp. Old hint text. -->');
    expect(oldHint).not.toBe(current);
    expect(generateReadme(oldHint)).toBe(current);
  });

  it('treats a CRLF checkout the same as LF', () => {
    const crlf = readme().replace(/\n/g, '\r\n');
    expect(generateReadme(crlf.replace(/\r\n/g, '\n'))).toBe(readme());
    expect(fs.readFileSync(new URL('../../.gitattributes', import.meta.url), 'utf8')).toMatch(/README\.md text eol=lf/);
  });

  it('rejects unknown template values, leftover tokens and broken markers', () => {
    expect(() => renderTemplate('{{ nope }}', {})).toThrow(/Unknown template value/);
    expect(() => renderTemplate('{{ a b }}', {})).toThrow(/Unrendered template token/);
    expect(() => replaceRegion('no markers', 'mcp', 'x')).toThrow(/missing the "mcp" generated-region markers/);
    const current = readme();
    const begin = current.slice(current.indexOf('<!-- BEGIN GENERATED: mcp'), current.indexOf('-->', current.indexOf('<!-- BEGIN GENERATED: mcp')) + 3);
    expect(() => replaceRegion(`${current}\n${begin}\n`, 'mcp', 'x')).toThrow(/more than one/);
  });
});

describe('mcp-remote pin check (npm run mcp:check-pin)', () => {
  const packument = ({ latest = '0.2.1', repoLatest = 'git+https://github.com/geelen/mcp-remote.git', deprecated } = {}) => ({
    name: 'mcp-remote',
    'dist-tags': { latest },
    time: { '0.2.1': '2026-08-24T00:00:00.000Z', '0.3.0': '2026-08-26T00:00:00.000Z', '0.3.1-beta.0': '2026-08-27T00:00:00.000Z' },
    versions: {
      '0.2.1': { repository: { url: 'git+https://github.com/geelen/mcp-remote.git' }, _npmUser: { name: 'a' }, deprecated },
      '0.3.0': { repository: { url: repoLatest }, _npmUser: { name: 'b' } },
      '0.3.1-beta.0': { repository: { url: repoLatest } },
    },
  });

  it('names the newest release that is at least 7 days old as the bump target', () => {
    const now = Date.parse('2026-09-03T00:00:00.000Z'); // 0.3.0 is 8 days old
    const report = evaluatePin(packument({ latest: '0.3.0' }), '0.2.1', {}, { now });
    expect(report.eligible.version).toBe('0.3.0');
    expect(formatReport(report)).toContain('Newest release at least 7 days old: 0.3.0');
    expect(formatReport(report)).toContain('pick a version at least 7 days old');
  });

  it('does not offer a release younger than 7 days as the bump target', () => {
    const now = Date.parse('2026-08-31T00:00:00.000Z'); // 0.3.0 is 5 days old
    const report = evaluatePin(packument({ latest: '0.3.0' }), '0.2.1', {}, { now });
    expect(report.eligible).toBeNull();
    expect(formatReport(report)).toContain('Newest release at least 7 days old: unknown');
  });

  it('flags a pin that is younger than 7 days', () => {
    const now = Date.parse('2026-08-28T00:00:00.000Z'); // 0.2.1 is 4 days old
    const report = evaluatePin(packument(), '0.2.1', {}, { now });
    expect(report.ok).toBe(false);
    expect(report.problems.join('\n')).toMatch(/younger than 7 days/);
  });

  it('passes when the pin is the latest release', () => {
    const report = evaluatePin(packument(), '0.2.1');
    expect(report.ok).toBe(true);
    expect(formatReport(report)).toContain('OK: the pin is the latest release.');
  });

  it('flags a pin that is behind, and a change of source repository', () => {
    const report = evaluatePin(packument({ latest: '0.3.0', repoLatest: 'git+https://github.com/other/mcp-remote.git' }), '0.2.1');
    expect(report.ok).toBe(false);
    expect(report.newerReleases).toEqual(['0.3.0']);
    expect(report.problems.join('\n')).toMatch(/behind latest 0\.3\.0 \(1 newer release/);
    expect(report.problems.join('\n')).toMatch(/declared repository changed/);
  });

  it('flags a change of provenance source even when the declared repository is unchanged', () => {
    const report = evaluatePin(packument({ latest: '0.3.0' }), '0.2.1', { '0.2.1': 'github.com/geelen/mcp-remote', '0.3.0': 'github.com/other/mcp-remote' });
    expect(report.problems.join('\n')).toMatch(/provenance source changed/);
  });

  it('compares by semver, not publish time, and ignores a lower latest tag', () => {
    const p = packument({ latest: '0.2.1' });
    p.versions['0.1.50'] = { repository: { url: 'git+https://github.com/geelen/mcp-remote.git' } };
    p.time['0.1.50'] = '2026-09-01T00:00:00.000Z';
    expect(evaluatePin(p, '0.2.1').newerReleases).toEqual(['0.3.0']);
    expect(evaluatePin(packument({ latest: '0.2.1' }), '0.3.0').problems.join('\n')).not.toMatch(/behind/);
  });

  it('normalizes repository forms', () => {
    expect(normalizeRepository({ url: 'git+https://github.com/Geelen/mcp-remote.git' })).toBe('github.com/geelen/mcp-remote');
    expect(normalizeRepository('github:geelen/mcp-remote')).toBe('github.com/geelen/mcp-remote');
    expect(normalizeRepository('https://github.com/geelen/mcp-remote')).toBe('github.com/geelen/mcp-remote');
  });

  it('keeps registry text from closing the issue code fence', () => {
    const report = evaluatePin(packument({ deprecated: '```\n@team click [here](x)' }), '0.2.1');
    expect(formatReport(report)).not.toContain('```');
  });

  it('uses distinct exit codes for needs-review and check failure', async () => {
    const body = packument({ latest: '0.3.0' });
    const fetchFn = async url => ({ ok: true, status: url.includes('/attestations/') ? 404 : 200, json: async () => body });
    const loadConfig = () => ({ mcpRemote: { package: 'mcp-remote', version: '0.2.1' } });
    const quiet = { log: () => {}, error: () => {} };
    expect(await runPinCheck([], { fetchFn, loadConfig, ...quiet })).toBe(EXIT.NEEDS_REVIEW);
    expect(await runPinCheck([], { fetchFn: async () => ({ ok: false, status: 503 }), loadConfig, ...quiet })).toBe(EXIT.CHECK_FAILED);
    expect(await runPinCheck([], { fetchFn: async () => ({ ok: true, status: 200, json: async () => null }), loadConfig, ...quiet })).toBe(EXIT.CHECK_FAILED);
    expect(await runPinCheck([], { fetchFn, loadConfig: () => { throw new Error('bad config'); }, ...quiet })).toBe(EXIT.CHECK_FAILED);
  });

  it('flags a missing or deprecated pinned version', () => {
    expect(evaluatePin(packument(), '0.0.1').problems.join('\n')).toMatch(/does not exist/);
    expect(evaluatePin(packument({ deprecated: 'use 0.3.0' }), '0.2.1').problems.join('\n')).toMatch(/deprecated/);
  });
});

describe('consumer check (npm run mcp:check-consumers)', () => {
  const quiet = { log: () => {}, error: () => {} };
  const localBytes = Buffer.from('{"a":1}\n');
  const sha = createHash('sha256').update(localBytes).digest('hex');
  const reply = body => async () => ({ ok: true, status: 200, json: async () => body });

  it('passes when the consumer pins the current file', async () => {
    expect(await runConsumerCheck({ fetchFn: reply({ ref: 'a'.repeat(40), sha256: sha }), localBytes, ...quiet })).toBe(0);
  });

  it('flags a consumer that pins another file, and fails closed on errors', async () => {
    const lines = [];
    expect(await runConsumerCheck({ fetchFn: reply({ ref: 'b'.repeat(40), sha256: 'f'.repeat(64) }), localBytes, log: l => lines.push(l), error: () => {} })).toBe(3);
    expect(lines.join('\n')).toMatch(/nansen-mcp-dxt: OUT OF SYNC.*npm run sync/);
    expect(await runConsumerCheck({ fetchFn: async () => ({ ok: false, status: 404 }), localBytes, ...quiet })).toBe(2);
    const fenced = [];
    await runConsumerCheck({ fetchFn: reply({ ref: '```\n@team', sha256: '```' }), localBytes, log: l => fenced.push(l), error: () => {} });
    expect(fenced.join('\n')).not.toContain('`');
  });
});
