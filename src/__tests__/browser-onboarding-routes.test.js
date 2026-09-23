import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { runCLI, SCHEMA } from '../cli.js';
import { NansenAPI } from '../api.js';
import { createAuthState } from '../auth-state.js';
import { createAuthStore } from '../auth-store.js';
import { resolveCredential } from '../auth-credentials.js';
import { memoryOperation, sessionFixture } from './fixtures/auth-fixture.js';
import examples from './fixtures/api508-skill-commands.json';

// Ancillary traffic is captured too; the resource transport below is real NansenAPI.request.
vi.mock('../update-check.js', () => ({ getUpdateNotification: () => null, getUpgradeNotice: () => null, scheduleUpdateCheck: vi.fn() }));
vi.mock('../cost-cache.js', () => ({ refreshCostMapIfStale: vi.fn(), getCostForEndpoint: () => null, creditsCharged: () => null }));
const skillDocs = Object.fromEntries(fs.readdirSync('skills').map(name => [name,
  ['SKILL.md', ...fs.readdirSync(`skills/${name}`).filter(f => f.endsWith('.md') && f !== 'SKILL.md')].map(f => fs.readFileSync(`skills/${name}/${f}`, 'utf8')).join('\n')]));
// Parse the independent fields in the repository's block-YAML frontmatter.
function credentialMetadata(text) {
  const frontmatter = text.split('---')[1] || '';
  const required = frontmatter.match(/^ {4}requires:\n((?:(?: {6,}[^\n]*|)\n)*)/m)?.[1] || '';
  const envBlock = required.match(/^ {6}env:\n((?: {8}- [^\n]+\n)*)/m)?.[1] || '';
  return { primaryEnv: frontmatter.match(/^ {4}primaryEnv: (.+)$/m)?.[1], requiredEnv: [...envBlock.matchAll(/- (\S+)/g)].map(m => m[1]) };
}
// Command families classify workflows, not server permissions. Unknown additions
// require an explicit transport/authorization assessment, never a key-only fallback.
const apiFamilies = new Set(['research', 'login', 'auth', 'account', 'agent', 'alerts', 'web']);
const walletFamilies = new Set(['trade', 'bridge', 'wallet', 'perp', 'doctor']);
function assertSkillScope(rows, docs) {
  const groups = { accountApi: [], walletWorkflow: [], standalonePayment: [] };
  for (const row of rows) if (!Object.hasOwn(docs, row.file.split('/')[1])) throw new Error(`Unknown inventory skill: ${row.file}`);
  for (const [name, text] of Object.entries(docs)) {
    const families = [...text.matchAll(/\bnansen ([a-z][a-z-]*)/g)].map(m => m[1]);
    if (name === 'nansen-mpp-payment') {
      if (families.some(f => f !== 'schema')) throw new Error(`Mixed standalone payment skill: ${name}`);
      expect(text).toContain('tempo'); groups.standalonePayment.push(name); continue;
    }
    if (!families.length || families.some(f => !apiFamilies.has(f) && !walletFamilies.has(f))) throw new Error(`Untraced command family: ${name}`);
    if (families.includes('research') && !rows.some(r => r.file.split('/')[1] === name) && !families.some(f => walletFamilies.has(f))) throw new Error(`Untraced research skill: ${name}`);
    const metadata = credentialMetadata(text);
    expect(metadata.primaryEnv, name).toBe('NANSEN_API_KEY');
    expect(metadata.requiredEnv, name).toEqual(name === 'nansen-trading' ? ['NANSEN_WALLET_PASSWORD'] : []);
    expect(text).toContain('## Authentication'); expect(text).toContain('nansen:api');
    expect(text).toContain('Browser rollout acceptance is still pending.');
    groups[families.some(f => walletFamilies.has(f)) ? 'walletWorkflow' : 'accountApi'].push(name);
  }
  expect(Object.values(groups).flat().sort()).toEqual(Object.keys(docs).sort());
  return groups;
}
let state, selection, bundle;
const unexpected = vi.fn(() => { throw new Error('Unexpected issuer/retirement request'); });
beforeAll(async () => {
  vi.stubEnv('DO_NOT_TRACK', '1'); vi.stubEnv('NANSEN_NO_TELEMETRY', '1');
  bundle = sessionFixture();
  state = createAuthState({ directory: path.join(process.env.HOME, '.nansen'), store: createAuthStore(memoryOperation()), retire: unexpected, refresh: unexpected });
  const operation = await state.begin(); await state.install(operation, { bundle, baseUrl: bundle.audience }); await state.finish(operation);
  selection = resolveCredential();
});
afterAll(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function assertComplete(result, calls, failures) {
  expect(result.code).toBe(0); expect(result.value?.type).toBe('success');
  expect(JSON.stringify(result.value?.data)).not.toMatch(/"error"\s*:/);
  expect(calls.length).toBeGreaterThan(0); expect(failures).toEqual([]);
}
async function dispatch(args, { fail = false, expand = false, kind = 'session' } = {}) {
  class SelectedAPI extends NansenAPI {
    constructor() { super(kind === 'api-key' ? 'synthetic-key' : undefined, bundle.audience, { ...(kind === 'session' && { credential: selection, authState: state }), retry: { maxRetries: 0 } }); }
  }
  const calls = [], failures = [], output = [];
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    const endpoint = new URL(url).pathname;
    const route = `${options.method || 'GET'} ${endpoint}`;
    calls.push(route);
    expect(new URL(url).origin).toBe(bundle.audience);
    expect(options.headers.Authorization).toBe(kind === 'session' ? `Bearer ${bundle.accessToken}` : undefined);
    expect(options.headers.apikey).toBe(kind === 'api-key' ? 'synthetic-key' : undefined);
    if (fail) { failures.push(route); return new Response(JSON.stringify({ error: 'synthetic failure' }), { status: 400 }); }
    const data = expand && endpoint.endsWith('/counterparties') ? [{ counterparty_address: '0x0000000000000000000000000000000000000003', volume_usd: 1 }] : [];
    return new Response(JSON.stringify({ data }));
  }));
  let code = 0;
  const value = await runCLI(args, { NansenAPIClass: SelectedAPI, isTTY: false, output: x => output.push(x), errorOutput: x => output.push(x), log: x => output.push(x), exit: x => { code = x; } });
  for (const secret of [bundle.accessToken, bundle.refreshToken, bundle.privateJwk.d]) expect(JSON.stringify(output)).not.toContain(secret);
  expect(unexpected).not.toHaveBeenCalled();
  return { result: { code, value }, calls, failures };
}
describe('published skill commands and account permission parity', () => {
  it('classifies every shipped workflow without an API-key-only eligibility gate', () => {
    assertSkillScope(examples, skillDocs);
    for (const text of Object.values(skillDocs)) expect(text).not.toContain('Fresh browser login does not grant agent access');
  });
  it.each(['wallet create', 'trade quote', 'agent "interpret"'])('rejects an unclassified new workflow: %s', command => {
    expect(() => assertSkillScope(examples, { ...skillDocs, 'nansen-new': `Run nansen ${command}` })).toThrow();
  });
  it('rejects untraced research, unknown families and mandatory-key metadata', () => {
    for (const text of ['No commands', 'nansen research token info', 'nansen future-command']) expect(() => assertSkillScope(examples, { ...skillDocs, 'new': text })).toThrow();
    const name = 'nansen-wallet-profiler';
    const required = skillDocs[name].replace('    requires:\n', '    requires:\n      env:\n        - NANSEN_API_KEY\n');
    expect(credentialMetadata(required)).toEqual({ primaryEnv: 'NANSEN_API_KEY', requiredEnv: ['NANSEN_API_KEY'] });
    expect(() => assertSkillScope(examples, { ...skillDocs, [name]: required })).toThrow();
  });
  it('inventories every literal research example, including embedded scripts and reference files', () => {
    const actual = [];
    for (const name of fs.readdirSync('skills')) {
      for (const file of fs.readdirSync(`skills/${name}`).filter(f => f.endsWith('.md'))) {
        const filename = `skills/${name}/${file}`;
        const text = fs.readFileSync(filename, 'utf8').replace(/\\\n/g, ' ');
        for (const match of text.matchAll(/nansen research [^`\n]+/g)) {
          const example = match[0].split('#')[0].trim();
          if (example.includes('<sub>') || example.includes(' <command>')) continue;
          // Bare category references are prose, not executable examples.
          const words = example.split(/\s+/);
          if (words.length < 4) continue;
          if (words[2] !== 'search' && (words[3].startsWith('<') || ['skill','for'].includes(words[3]))) continue;
          actual.push({ file: filename, example });
        }
      }
    }
    expect(actual.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual(examples.map(({file,example}) => ({file,example})).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  });
  it.each(examples)('$file: $example', async row => {
    for (const kind of ['api-key', 'session']) {
      const { result, calls, failures } = await dispatch(row.args, { kind });
      assertComplete(result, calls, failures);
      expect([...new Set(calls)].sort()).toEqual(row.expectedRoutes);
    }
  });
  it.each([
    ['skills/nansen-sm-cross-chain-flows/SKILL.md', ['ethereum','solana','base','bnb']],
    ['skills/nansen-wallet-clustering/REFERENCE.md', ['base','arbitrum','optimism','polygon']],
  ])('expands every chain in the embedded loop in %s', async (file, chains) => {
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain(file.includes('sm-cross') ? `CHAINS=(${chains.join(' ')})` : `for CHAIN in ${chains.join(' ')}; do`);
    const row = examples.find(r => r.file === file && /\$chain/i.test(r.example));
    expect(row).toBeTruthy();
    for (const chain of chains) {
      const args = [...row.args]; args[args.indexOf('--chain') + 1] = chain;
      const { result, calls, failures } = await dispatch(args);
      assertComplete(result, calls, failures); expect([...new Set(calls)].sort()).toEqual(row.expectedRoutes);
    }
  });
  it('traverses a nonempty trace and refuses to treat partial composite results as acceptance', async () => {
    const row = examples.find(r => r.args.includes('trace'));
    const success = await dispatch([...row.args, '--delay', '0'], { expand: true });
    assertComplete(success.result, success.calls, success.failures);
    expect(success.calls.length).toBeGreaterThan(1);
    for (const sub of ['trace','batch','compare']) {
      const example = examples.find(r => r.args.includes(sub));
      const partial = await dispatch(example.args, { fail: true });
      expect(() => assertComplete(partial.result, partial.calls, partial.failures)).toThrow();
    }
    const unknown = await dispatch(['research','token','not-a-command']);
    expect(() => assertComplete(unknown.result, unknown.calls, unknown.failures)).toThrow();
  });
  it('renders login, account, auth and schema guidance through public commands', async () => {
    const output = [];
    for (const args of [['--help'],['login','--help'],['auth','--help'],['account','--help'],['schema']]) {
      const result = await runCLI(args, { output: x => output.push(x), errorOutput: x => output.push(x), exit: code => { throw new Error(`Unexpected help exit ${code}`); } });
      expect(result).toBeTruthy();
    }
    const text = output.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join('\n');
    for (const phrase of ['NANSEN_API_KEY','--no-browser','--human','unverified','402']) expect(text).toContain(phrase);
    expect(text).not.toContain('Only admitted direct-data research');
    expect(text).not.toContain('agent, portfolio, web and execution are excluded');
    expect(SCHEMA.commands.login.description.toLowerCase()).toContain('fresh');
    expect(SCHEMA.commands.research.description).toContain('same account API permissions');
  });
});
