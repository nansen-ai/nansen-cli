import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { runCLI, SCHEMA } from '../cli.js';
import { NansenAPI } from '../api.js';
import { createAuthState } from '../auth-state.js';
import { createAuthStore } from '../auth-store.js';
import { resolveCredential } from '../auth-credentials.js';
import { memoryOperation, sessionFixture } from './fixtures/auth-fixture.js';
import contract from './fixtures/api508-admitted-routes.json';
import examples from './fixtures/api508-skill-commands.json';

// Ancillary traffic is captured too; the resource transport below is real NansenAPI.request.
vi.mock('../update-check.js', () => ({ getUpdateNotification: () => null, getUpgradeNotice: () => null, scheduleUpdateCheck: vi.fn() }));
vi.mock('../cost-cache.js', () => ({ refreshCostMapIfStale: vi.fn(), getCostForEndpoint: () => null, creditsCharged: () => null }));
const admitted = new Set(contract.routes.map(r => r.join(' ')));
const skillDocs = Object.fromEntries(fs.readdirSync('skills').map(name => [name,
  ['SKILL.md', ...fs.readdirSync(`skills/${name}`).filter(f => f.endsWith('.md') && f !== 'SKILL.md')].map(f => fs.readFileSync(`skills/${name}/${f}`, 'utf8')).join('\n')]));
// Parse the independent fields in the repository's block-YAML frontmatter.
function credentialMetadata(text) {
  const frontmatter = text.split('---')[1] || '';
  const required = frontmatter.match(/^ {4}requires:\n((?:(?: {6,}[^\n]*|)\n)*)/m)?.[1] || '';
  const envBlock = required.match(/^ {6}env:\n((?: {8}- [^\n]+\n)*)/m)?.[1] || '';
  return { primaryEnv: frontmatter.match(/^ {4}primaryEnv: (.+)$/m)?.[1], requiredEnv: [...envBlock.matchAll(/- (\S+)/g)].map(m => m[1]) };
}
function supportsBrowserSkill(name, rows, docs) {
  const commands = rows.filter(r => r.file.split('/')[1] === name);
  // All reference files count. Non-research operations cannot be hidden behind
  // one admitted data example (agent-guide is intentionally mixed).
  const families = [...docs[name].matchAll(/\bnansen ([a-z][a-z-]*)/g)].map(m => m[1]);
  return commands.length > 0 && commands.every(r => r.expectedRoutes.length > 0 && r.expectedRoutes.every(route => admitted.has(route))) &&
    families.every(f => ['research', 'login', 'auth', 'account'].includes(f));
}
const browserFamilies = new Set(['research', 'login', 'auth', 'account']);
const keyOnlyFamilies = new Set(['agent', 'alerts', 'trade', 'wallet', 'perp', 'web', 'doctor']);
function assertSkillScope(rows, docs) {
  const groups = { conditional: [], keyOnly: [], standalonePayment: [] };
  for (const row of rows) {
    if (!Object.hasOwn(docs, row.file.split('/')[1])) throw new Error(`Unknown inventory skill: ${row.file}`);
  }
  for (const [name, text] of Object.entries(docs)) {
    const commands = rows.filter(r => r.file.split('/')[1] === name);
    const families = [...text.matchAll(/\bnansen ([a-z][a-z-]*)/g)].map(m => m[1]);
    // One explicitly separate payment rail; never a general escape for untraced skills.
    if (name === 'nansen-mpp-payment') {
      if (commands.length || families.some(f => f !== 'schema')) throw new Error(`Mixed standalone payment skill: ${name}`);
      groups.standalonePayment.push(name);
      continue;
    }
    if (families.some(f => !browserFamilies.has(f) && !keyOnlyFamilies.has(f))) throw new Error(`Unknown command family: ${name}`);
    const metadata = credentialMetadata(text);
    if (supportsBrowserSkill(name, rows, docs)) {
      expect(text).toContain('## Authentication');
      expect(metadata.primaryEnv).toBe('NANSEN_API_KEY');
      expect(metadata.requiredEnv).toEqual([]);
      groups.conditional.push(name);
    } else {
      if (text.includes('## Authentication')) throw new Error(`Mixed or untraced browser skill: ${name}`);
      const excluded = commands.some(r => r.expectedRoutes.some(route => !admitted.has(route))) || families.some(f => keyOnlyFamilies.has(f));
      if (!excluded) throw new Error(`Untraced skill: ${name}`);
      expect(metadata.requiredEnv, name).toContain('NANSEN_API_KEY');
      expect(metadata.primaryEnv, name).toBe('NANSEN_API_KEY');
      groups.keyOnly.push(name);
    }
  }
  expect(Object.values(groups).flat().sort()).toEqual(Object.keys(docs).sort());
  return groups;
}
const conditional = Object.keys(skillDocs).filter(name => supportsBrowserSkill(name, examples, skillDocs));
const excludedRoute = /\/(?:agent|portfolio|web|beta|v1beta1|internal|execution|wallet)(?:\/|$)|\/search\/web-(?:search|fetch)/;
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
class SessionAPI extends NansenAPI {
  constructor(_key, _base, options) { super(undefined, bundle.audience, { ...options, credential: selection, authState: state, retry: { maxRetries: 0 } }); }
}
function assertComplete(result, calls, failures) {
  expect(result.code).toBe(0); expect(result.value?.type).toBe('success');
  expect(JSON.stringify(result.value?.data)).not.toMatch(/"error"\s*:/);
  expect(calls.length).toBeGreaterThan(0); expect(failures).toEqual([]);
}
async function dispatch(args, { fail = false, expand = false } = {}) {
  const calls = [], failures = [], output = [];
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    const endpoint = new URL(url).pathname;
    const route = `${options.method || 'GET'} ${endpoint}`;
    calls.push(route);
    expect(new URL(url).origin).toBe(bundle.audience);
    expect(options.headers.Authorization).toBe(`Bearer ${bundle.accessToken}`);
    expect(options.headers.apikey).toBeUndefined();
    if (fail) { failures.push(route); return new Response(JSON.stringify({ error: 'synthetic failure' }), { status: 400 }); }
    const data = expand && endpoint.endsWith('/counterparties') ? [{ counterparty_address: '0x0000000000000000000000000000000000000003', volume_usd: 1 }] : [];
    return new Response(JSON.stringify({ data }));
  }));
  let code = 0;
  const value = await runCLI(args, { NansenAPIClass: SessionAPI, isTTY: false, output: x => output.push(x), errorOutput: x => output.push(x), log: x => output.push(x), exit: x => { code = x; } });
  for (const secret of [bundle.accessToken, bundle.refreshToken, bundle.privateJwk.d]) expect(JSON.stringify(output)).not.toContain(secret);
  expect(unexpected).not.toHaveBeenCalled();
  return { result: { code, value }, calls, failures };
}
describe('published skill commands against frozen API505 method/path contract', () => {
  it('pins 58 unique routes and exactly 23 conditional / 10 key-only skills', () => {
    expect(admitted.size).toBe(58); expect(conditional).toHaveLength(23);
    const groups = assertSkillScope(examples, skillDocs);
    expect(groups.keyOnly).toHaveLength(10);
    expect(groups.standalonePayment).toEqual(['nansen-mpp-payment']);
    for (const name of conditional) {
      const text = fs.readFileSync(`skills/${name}/SKILL.md`, 'utf8');
      const metadata = credentialMetadata(text);
      expect(metadata.primaryEnv).toBe('NANSEN_API_KEY');
      expect(metadata.requiredEnv).toEqual([]);
      for (const prerequisite of ['Cached access-token expiry alone does not mean the session is unusable', 'already-authorized research task, without another consent request or a separate account check', 'Stop on anonymous selection, invalid authentication state, blocked or uncertain renewal/cleanup', 'rejected or expired refresh authority', 'Do not run this research workflow anonymously.']) expect(text).toContain(prerequisite);
      expect(text).toContain('Browser rollout acceptance is still pending.');
    }
  });
  it('rejects a mixed-scope skill even when an admitted example and optional key mapping remain', () => {
    const name = 'nansen-wallet-deep-dive';
    const excluded = { file: `skills/${name}/SKILL.md`, example: 'nansen research portfolio defi --wallet $ADDR', expectedRoutes: ['POST /api/v1/portfolio/defi-holdings'], admitted: false };
    const docs = { ...skillDocs, [name]: skillDocs[name] + '\nnansen research portfolio defi --wallet $ADDR\n' };
    expect(credentialMetadata(docs[name])).toEqual({ primaryEnv: 'NANSEN_API_KEY', requiredEnv: [] });
    expect(() => assertSkillScope([...examples, excluded], docs)).toThrow(`Mixed or untraced browser skill: ${name}`);
    expect(() => assertSkillScope(examples, { ...skillDocs, [name]: skillDocs[name] + '\nnansen agent "interpret"\n' })).toThrow(`Mixed or untraced browser skill: ${name}`);
    const required = skillDocs[name].replace('    requires:\n', '    requires:\n      env:\n        - NANSEN_API_KEY\n');
    expect(credentialMetadata(required)).toEqual({ primaryEnv: 'NANSEN_API_KEY', requiredEnv: ['NANSEN_API_KEY'] });
    expect(() => assertSkillScope(examples, { ...skillDocs, [name]: required })).toThrow();
  });
  it.each(['wallet create', 'trade quote', 'agent "interpret"'])('rejects an unlisted key-only skill without metadata: %s', command => {
    const name = 'nansen-new-skill';
    const text = `---\nname: ${name}\n---\nRun nansen ${command}\n`;
    expect(() => assertSkillScope(examples, { ...skillDocs, [name]: text })).toThrow();
    const withMetadata = text.replace('\n---\nRun', '\nmetadata:\n  openclaw:\n    requires:\n      env:\n        - NANSEN_API_KEY\n    primaryEnv: NANSEN_API_KEY\n---\nRun');
    expect(assertSkillScope(examples, { ...skillDocs, [name]: withMetadata }).keyOnly).toContain(name);
  });
  it.each(['No executable command documented.', 'Run nansen research token info', 'Run nansen future-command'])('refuses untraced or unknown new skills: %s', text => {
    expect(() => assertSkillScope(examples, { ...skillDocs, 'nansen-untraced': text })).toThrow();
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
    const { result, calls, failures } = await dispatch(row.args);
    assertComplete(result, calls, failures);
    expect([...new Set(calls)].sort()).toEqual(row.expectedRoutes);
    expect(calls.every(r => admitted.has(r))).toBe(row.admitted);
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
      assertComplete(result, calls, failures); expect(calls.every(r => admitted.has(r))).toBe(true);
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
  it('keeps excluded route families out of the admitted fixture', () => {
    for (const route of admitted) expect(route).not.toMatch(excludedRoute);
    expect('POST /api/v1beta1/tgm/historical-dex-trades').toMatch(excludedRoute);
    expect('POST /api/v1/search/web-search').toMatch(excludedRoute);
  });
  it('renders login, account, auth and schema guidance through public commands', async () => {
    const output = [];
    for (const args of [['--help'],['login','--help'],['auth','--help'],['account','--help'],['schema']]) {
      const result = await runCLI(args, { output: x => output.push(x), errorOutput: x => output.push(x), exit: code => { throw new Error(`Unexpected help exit ${code}`); } });
      expect(result).toBeTruthy();
    }
    const text = output.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join('\n');
    for (const phrase of ['NANSEN_API_KEY','--no-browser','--human','unverified','402']) expect(text).toContain(phrase);
    expect(SCHEMA.commands.login.description).toContain('fresh');
    expect(SCHEMA.commands.research.description).toContain('stable-v1 direct-data');
  });
});
