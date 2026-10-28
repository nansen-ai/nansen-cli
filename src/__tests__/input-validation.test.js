/**
 * API-1080 / API-1081: one validation path for research commands.
 *
 * Unit tests pin the wording (it mirrors the REST API's 422 messages) and the
 * suggestion algorithm (Python difflib, as used by the REST API and the MCP
 * server). The schema-wide tests run every research command through runCLI
 * against a request-capturing API, so a flag that the schema accepts but the
 * handler drops (the "--limit is ignored" class of bug) fails here.
 */

import { describe, it, expect } from 'vitest';
import { NansenAPI } from '../api.js';
import { runCLI, SCHEMA, API_ENDPOINTS } from '../cli.js';
import {
  similarity,
  closestMatch,
  quotedList,
  normalizeFilterAddresses,
  resolveResearchCommand,
  validateResearchInput,
  validateFieldSelection,
  validateOutputOptions,
} from '../input-validation.js';

const EVM = '0x28c6c06298d514db089934071355e5743bf21d60';
const EVM_MIXED = '0x28C6c06298d514Db089934071355E5743bf21d60';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TX_HASH = `0x${'ab'.repeat(32)}`;

// ============= Helpers =============

function capture(error) {
  return {
    message: error.message,
    code: error.code,
    details: error.details,
  };
}

function check(path, args = {}, flags = {}) {
  const [command, ...subArgs] = path.split(' ');
  const resolved = resolveResearchCommand(SCHEMA, command, subArgs);
  try {
    validateResearchInput(resolved, { flags, options: args, endpoints: API_ENDPOINTS, chains: SCHEMA.chains });
    return null;
  } catch (error) {
    return capture(error);
  }
}

/** Every research leaf: [path words, leaf]. */
function researchLeaves() {
  const leaves = [];
  for (const [category, entry] of Object.entries(SCHEMA.commands.research.subcommands)) {
    if (category === 'points') continue;
    if (entry.subcommands) {
      for (const [sub, leaf] of Object.entries(entry.subcommands)) leaves.push([['research', category, sub], leaf]);
    } else {
      leaves.push([['research', category], entry]);
    }
  }
  return leaves;
}

/** Sample values that pass local checks for each required option. */
function sampleValue(name, spec) {
  if (Array.isArray(spec.enum) && spec.enum.length) return String(spec.enum[0]);
  if (spec.format === 'date') return '2025-01-01';
  return {
    address: EVM,
    addresses: EVM,
    wallet: EVM,
    token: SOL_MINT,
    'token-address': SOL_MINT,
    symbol: 'BTC',
    'market-id': '12345',
    query: 'eth',
    'from-date': '2025-01-01',
    'to-date': '2025-01-02',
    'as-of-date': '2025-01-02',
    'timeframe-days': '7',
    'transaction-hash': TX_HASH,
  }[name] ?? 'x';
}

function requiredArgs(leaf, { evmToken = false, skip = [] } = {}) {
  const args = [];
  for (const [name, spec] of Object.entries(leaf.options || {})) {
    if (skip.includes(name)) continue;
    const needed = spec.required || (name === 'as-of-date' && leaf.options['as-of-ts']);
    if (!needed) continue;
    const token = evmToken && (name === 'token' || name === 'token-address');
    args.push(`--${name}`, token ? EVM : sampleValue(name, spec));
  }
  return args;
}

/** A value for an optional option that differs from its default. */
function probeValue(name, spec, leaf) {
  if (spec.type === 'boolean') return spec.default === true ? 'false' : 'true';
  if (name === 'chain' || name === 'chains') {
    const list = API_ENDPOINTS[leaf.endpoint]?.chains ?? spec.enum ?? ['base'];
    return ['base', 'ethereum'].find(chain => list.includes(chain) && chain !== spec.default) ?? list.find(chain => chain !== spec.default);
  }
  if (Array.isArray(spec.enum) && spec.enum.length) return String(spec.enum.find(value => String(value) !== String(spec.default)) ?? spec.enum[0]);
  if (spec.type === 'number' || spec.type === 'integer') {
    let value = (spec.minimum ?? 0) + 3;
    if (value === spec.default) value++;
    return String(spec.maximum !== undefined ? Math.min(value, spec.maximum) : value);
  }
  if (spec.format === 'date' || name === 'date') return '2025-02-03';
  if (spec.format === 'date-time') return '2025-02-03T00:00:00Z';
  if (spec.format === 'json') return name === 'filters' ? JSON.stringify({ probe_field: 1 }) : JSON.stringify([{ field: 'probe_field', direction: 'ASC' }]);
  return { address: EVM, addresses: EVM, wallet: EVM, token: SOL_MINT, 'token-address': SOL_MINT, 'transaction-hash': TX_HASH }[name] ?? 'probe-value';
}

// Options that change what the CLI does with the response, not the request.
const CLIENT_SIDE_OPTIONS = new Set([
  'research profiler counterparties-batch --file', // reads the addresses from a file instead of --addresses
  'research token transfers --enrich', // looks up labels for the returned addresses
]);

async function runCaptured(argv) {
  const calls = [];
  const outputs = [];
  let exitCode = null;
  class CaptureAPI extends NansenAPI {
    constructor() {
      super('test-key', 'https://api.nansen.ai', { retry: { maxRetries: 0 }, cache: { enabled: false } });
    }

    async request(endpoint, body = {}) {
      calls.push({ endpoint, body: JSON.parse(JSON.stringify(NansenAPI.cleanBody(body))) });
      return { data: [{ token_symbol: 'X', value_usd: 1 }] };
    }
  }
  const result = await runCLI(argv, {
    output: line => outputs.push(line),
    errorOutput: () => {},
    exit: code => { exitCode = code; },
    NansenAPIClass: CaptureAPI,
    isTTY: false,
  });
  const last = outputs.length ? outputs[outputs.length - 1] : null;
  let parsed = null;
  try { parsed = JSON.parse(last); } catch { /* not JSON */ }
  return { calls, result, exitCode, output: parsed };
}

// ============= Suggestions =============

describe('similarity / closestMatch (difflib parity)', () => {
  it.each([
    ['timefrme', 'timeframe', 0.9411764705882353],
    ['bitcoin', 'ton', 0.6],
    ['abc', 'xyz', 0],
    ['', '', 1],
  ])('ratio(%s, %s) = %f', (a, b, expected) => {
    expect(similarity(a, b)).toBeCloseTo(expected, 12);
  });

  it('suggests the closest candidate above the cutoff', () => {
    expect(closestMatch('timefrme', ['chain', 'timeframe', 'token'])).toBe('timeframe');
    expect(closestMatch('scrrener', ['screener', 'info'])).toBe('screener');
    expect(closestMatch('TimeFrame', ['timeframe'])).toBe('timeframe');
  });

  it('scores like get_close_matches (candidate first, then the word)', () => {
    // SequenceMatcher(None, 'chain', 'cnani').ratio() is 0.6; the reverse is 0.4.
    expect(closestMatch('cnani', ['chain'])).toBe('chain');
  });

  it('returns null when nothing is close', () => {
    expect(closestMatch('turbo', ['chain', 'timeframe', 'token'])).toBeNull();
  });

  it('formats lists like the REST API', () => {
    expect(quotedList(['json'])).toBe("'json'");
    expect(quotedList(['json', 'csv'])).toBe("'json' or 'csv'");
    expect(quotedList(['a', 'b', 'c'])).toBe("'a', 'b' or 'c'");
  });
});

// ============= Command resolution =============

describe('resolveResearchCommand', () => {
  it('resolves research, deprecated top-level and perp analytics paths', () => {
    expect(resolveResearchCommand(SCHEMA, 'research', ['token', 'info']).path).toBe('nansen research token info');
    expect(resolveResearchCommand(SCHEMA, 'research', ['tgm', 'info']).path).toBe('nansen research token info');
    expect(resolveResearchCommand(SCHEMA, 'token', ['info']).path).toBe('nansen token info');
    expect(resolveResearchCommand(SCHEMA, 'perp', ['screener']).path).toBe('nansen perp screener');
    expect(resolveResearchCommand(SCHEMA, 'research', ['historical-dex-trades']).path).toBe('nansen research historical-dex-trades');
    expect(resolveResearchCommand(SCHEMA, 'research', ['portfolio', 'defi-holdings']).path).toBe('nansen research portfolio defi');
  });

  it('skips help and non-research commands', () => {
    expect(resolveResearchCommand(SCHEMA, 'research', [])).toBeNull();
    expect(resolveResearchCommand(SCHEMA, 'research', ['token'])).toBeNull();
    expect(resolveResearchCommand(SCHEMA, 'research', ['token', 'help'])).toBeNull();
    expect(resolveResearchCommand(SCHEMA, 'perp', ['order'])).toBeNull();
    expect(resolveResearchCommand(SCHEMA, 'wallet', ['list'])).toBeNull();
  });

  it('rejects a subcommand typo with the closest match', () => {
    expect(() => resolveResearchCommand(SCHEMA, 'research', ['token', 'scrrener'])).toThrow(
      expect.objectContaining({
        code: 'UNKNOWN_COMMAND',
        message: expect.stringMatching(/^Unknown token subcommand: scrrener\. Did you mean 'screener'\? Available: /),
      }),
    );
    expect(() => resolveResearchCommand(SCHEMA, 'research', ['tokn', 'screener'])).toThrow(
      expect.objectContaining({ code: 'UNKNOWN_COMMAND', details: expect.objectContaining({ suggestion: 'token' }) }),
    );
  });
});

// ============= Option validation =============

describe('validateResearchInput', () => {
  it('rejects an unknown option with the valid option list', () => {
    const error = check('research token info', { token: SOL_MINT, timefrme: '30d' });
    expect(error).toEqual({
      message: "Option '--timefrme' is not recognized by nansen research token info. Command-specific options: --chain, --token, --timeframe. Common options also apply; see: nansen schema.",
      code: 'INVALID_PARAMS',
      details: {
        param: '--timefrme',
        errors: [{
          field: '--timefrme',
          message: "Option '--timefrme' is not recognized by nansen research token info. Command-specific options: --chain, --token, --timeframe. Common options also apply; see: nansen schema.",
          code: 'unknown_field',
        }],
      },
    });
  });

  it('lists the valid options for an invented name (--turbo)', () => {
    const error = check('research token info', { token: SOL_MINT }, { turbo: true });
    expect(error.message).toBe("Option '--turbo' is not recognized by nansen research token info. Command-specific options: --chain, --token, --timeframe. Common options also apply; see: nansen schema.");
  });

  it('rejects an unknown short flag', () => {
    expect(check('research token info', { token: SOL_MINT }, { x: true }).details.param).toBe('-x');
  });

  it('keeps common options valid alongside a command-specific option list', () => {
    const options = {
      token: SOL_MINT, retries: '2', 'cache-ttl': '60', 'x402-payment-signature': 'test-signature',
    };
    const flags = { cache: true, 'no-cache': true, debug: true, stream: true };
    expect(check('research token info', options, flags)).toBeNull();
    const error = check('research token info', options, { ...flags, turbo: true });
    expect(error.details.errors).toHaveLength(1);
    expect(error.message).toBe("Option '--turbo' is not recognized by nansen research token info. Command-specific options: --chain, --token, --timeframe. Common options also apply; see: nansen schema.");
  });

  it('lists all pagination controls only when the command supports them', () => {
    const paginated = check('research profiler balance', { address: EVM }, { turbo: true });
    const unpaginated = check('research token info', { token: SOL_MINT }, { turbo: true });
    for (const option of ['--limit', '--page', '--paginate', '--all', '--max-pages']) {
      expect(paginated.message).toContain(option);
      expect(unpaginated.message).not.toContain(option);
    }
  });

  it.each([
    ['research profiler balance', { address: EVM, limit: '4' }, null],
    ['research token ohlcv', { token: SOL_MINT, limit: '4' }, "Option '--limit' is not supported by nansen research token ohlcv: this endpoint does not paginate."],
    ['research profiler perp-positions', { address: EVM, page: '2' }, "Option '--page' is not supported by nansen research profiler perp-positions: this endpoint does not paginate."],
    ['research smart-money holdings', { token: EVM }, null],
    ['research prediction-market position-detail', { 'market-id': '1', address: EVM }, "Option '--address' is not recognized by nansen research prediction-market position-detail. Command-specific options: --market-id, --limit, --page, --paginate, --all, --max-pages. Common options also apply; see: nansen schema."],
  ])('%s with %j: flags the command used to ignore', (path, args, message) => {
    const error = check(path, args);
    if (message === null) expect(error).toBeNull();
    else expect(error.message).toBe(message);
  });

  it('rejects a paginate flag on an endpoint without pagination', () => {
    expect(check('research token ohlcv', { token: SOL_MINT }, { paginate: true }).details.param).toBe('--paginate');
  });

  it('reports a missing required option locally (with the alternative)', () => {
    expect(check('research profiler balance', { chain: 'ethereum' })).toMatchObject({
      message: "Required option '--address' is missing (or pass --entity).",
      code: 'MISSING_PARAM',
      details: { param: '--address', errors: [{ field: '--address', code: 'missing_field' }] },
    });
    expect(check('research profiler balance', { entity: 'Binance' })).toBeNull();
    expect(check('research profiler balance', { 'entity-name': 'Binance' })).toBeNull();
    expect(check('research token info', {}).message).toBe("Required option '--token' is missing.");
    expect(check('research token info', { 'token-address': SOL_MINT })).toBeNull();
  });

  it('accepts a positional query for search', () => {
    const resolved = resolveResearchCommand(SCHEMA, 'search', ['bitcoin']);
    expect(() => validateResearchInput(resolved, { options: {}, endpoints: API_ENDPOINTS })).not.toThrow();
  });

  it.each([
    [{ chain: '' }, "Option '--chain' requires a value."],
    [{}, "Option '--chain' requires a value.", { chain: true }],
  ])('rejects a blank value %j', (args, message, flags = {}) => {
    expect(check('research token info', { token: SOL_MINT, ...args }, flags)).toMatchObject({
      message,
      code: 'MISSING_PARAM',
    });
  });

  it.each([
    ['research smart-money netflow', { page: '0' }, "Value for '--page' is out of the allowed range (must be at least 1); received: 0"],
    ['research smart-money netflow', { limit: 'ten' }, "Option '--limit' must be a whole number; received: ten"],
    ['research historical-dex-trades', { 'token-address': SOL_MINT, 'from-date': '2024-13-45', 'to-date': '2024-01-02' }, "Invalid date '2024-13-45' for --from-date. Expected YYYY-MM-DD or an ISO 8601 time such as 2025-01-01T00:00:00Z."],
    ['research token flows', { token: SOL_MINT, label: 'smart-mony' }, "Invalid value 'smart-mony' for --label. Did you mean 'smart_money'? Valid options are: 'top_100_holders', 'smart_money', 'public_figure', 'whale' or 'exchange'"],
  ])('%s %j: invalid value', (path, args, message) => {
    expect(check(path, args)?.message).toBe(message);
  });

  it('rejects inherited object properties as subcommands', () => {
    expect(() => resolveResearchCommand(SCHEMA, 'research', ['token', 'toString'])).toThrow(expect.objectContaining({ code: 'UNKNOWN_COMMAND' }));
    expect(() => resolveResearchCommand(SCHEMA, 'research', ['constructor'])).toThrow(expect.objectContaining({ code: 'UNKNOWN_COMMAND' }));
  });

  it('accepts every flag the token handlers apply to filters', () => {
    for (const sub of ['who-bought-sold', 'pnl', 'transfers', 'jup-dca']) {
      expect(check(`research token ${sub}`, { token: SOL_MINT }, { 'smart-money': true }), sub).toBeNull();
    }
    for (const sub of ['perp-positions', 'perp-trades', 'perp-pnl-leaderboard']) {
      expect(check(`research token ${sub}`, { symbol: 'BTC' }, { 'smart-money': true }), sub).toBeNull();
    }
    expect(check('research token screener', {}, { 'include-stablecoins': true })).toBeNull();
  });

  it('rejects a JSON value for a plain option instead of dropping it', () => {
    expect(check('research token info', { token: SOL_MINT, timeframe: {} })).toMatchObject({
      message: "Option '--timeframe' must be a string, not JSON; received: {}",
      code: 'INVALID_PARAMS',
    });
    expect(check('research token info', { token: [SOL_MINT, SOL_MINT] }).message).toBe("Option '--token' may only be given once");
    expect(check('research smart-money netflow', { labels: ['Fund', '30D Smart Trader'] })).toBeNull();
    // JSON arrays are values, not repeats.
    expect(check('research smart-money netflow', { 'order-by': [{ field: 'value_usd', direction: 'DESC' }] })).toBeNull();
    expect(check('research profiler compare', { addresses: [EVM, EVM_MIXED] })).toBeNull();
    expect(check('research profiler counterparties-batch', { addresses: [EVM] })).toBeNull();
  });

  it('accepts ISO times where the API takes a date range', () => {
    expect(check('research historical-dex-trades', { 'token-address': SOL_MINT, 'from-date': '2026-01-01T12:00:00Z', 'to-date': '2026-01-02' })).toBeNull();
    expect(check('research historical-dex-trades', { 'token-address': SOL_MINT, 'from-date': '2026-01-01T25:00:00Z', 'to-date': '2026-01-02' })?.details.param).toBe('--from-date');
    expect(check('research historical-top-holders', { 'token-address': SOL_MINT, 'as-of-date': '2026-01-01T12:00:00Z' })?.details.param).toBe('--as-of-date');
  });

  it('accepts the 4h historical OHLCV timeframe', () => {
    expect(check('research historical-token-ohlcv', { 'token-address': SOL_MINT, 'from-date': '2026-01-01', 'as-of-date': '2026-01-02', timeframe: '4h' })).toBeNull();
  });

  it('collects every error, led by the first (like the REST errors list)', () => {
    const error = check('research token info', { timefrme: '1d', chain: 'etherium' });
    expect(error.details.errors.map(e => e.code)).toEqual(['unknown_field', 'missing_field', 'invalid_field_value']);
    expect(error.message).toMatch(/\(2 more errors in details\.errors\)$/);
  });

  describe('chains', () => {
    it('rejects a chain the endpoint does not accept, with the supported list', () => {
      const error = check('research token flow-intelligence', { token: '1111111111111111111114oLvT2', chain: 'bitcoin' });
      expect(error.message).toMatch(/^Chain 'bitcoin' is not supported by nansen research token flow-intelligence\. Supported chains: arbitrum, /);
      expect(error.message).not.toContain('Did you mean');
      expect(error.details.errors[0]).toMatchObject({ field: '--chain', code: 'invalid_field_value' });
    });

    it('accepts bitcoin where the endpoint supports it', () => {
      expect(check('research token holders', { token: '1111111111111111111114oLvT2', chain: 'bitcoin' })).toBeNull();
    });

    it('suggests a typo', () => {
      expect(check('research smart-money netflow', { chain: 'etherium' }).message).toContain("Did you mean 'ethereum'?");
    });

    it('accepts and normalises the REST API aliases and case', () => {
      const options = { chain: 'BSC' };
      expect(check('research smart-money netflow', options)).toBeNull();
      const resolved = resolveResearchCommand(SCHEMA, 'research', ['smart-money', 'netflow']);
      const mutable = { chain: 'ETH', chains: 'sol,Base' };
      validateResearchInput(resolved, { options: mutable, endpoints: API_ENDPOINTS, chains: SCHEMA.chains });
      expect(mutable).toEqual({ chain: 'ethereum', chains: ['solana', 'base'] });
    });

    it('turns --chains into an array however it was given', () => {
      const resolved = resolveResearchCommand(SCHEMA, 'research', ['token', 'screener']);
      for (const chains of ['eth, SOL', ['eth', 'SOL'], ['eth,sol'], ['ETH', 'base,sol']]) {
        const mutable = { chains };
        validateResearchInput(resolved, { options: mutable, endpoints: API_ENDPOINTS, chains: SCHEMA.chains });
        expect(mutable.chains).toEqual(Array.isArray(chains) && chains.length === 2 && chains[1].includes(',') ? ['ethereum', 'base', 'solana'] : ['ethereum', 'solana']);
      }
    });

    it('rejects a list option with no items', () => {
      for (const chains of [',', ' , ', [',']]) {
        const error = check('research token screener', { chains });
        expect(error.details.errors[0]).toMatchObject({ field: '--chains', code: 'missing_field' });
      }
    });

    it('takes the chain list from the API spec over a hand-written enum', () => {
      expect(check('research transaction-with-token-transfer-lookup', { 'transaction-hash': TX_HASH, chain: 'arc' })).toBeNull();
    });

    it('checks every entry of --chains', () => {
      const error = check('research smart-money netflow', { chains: 'ethereum,notachain' });
      expect(error.details.errors).toHaveLength(1);
      expect(error.message).toMatch(/^Chain 'notachain' is not supported/);
    });

    it('accepts bsc for batch counterparties', () => {
      expect(check('research profiler counterparties-batch', { addresses: EVM, chain: 'bsc' })).toBeNull();
    });
  });
});

describe('validateOutputOptions', () => {
  it('rejects --format xml', () => {
    expect(() => validateOutputOptions({ options: { format: 'xml' } })).toThrow("Invalid value 'xml' for --format. Valid options are: 'json' or 'csv'");
    expect(() => validateOutputOptions({ options: { format: 'jsn' } })).toThrow("Did you mean 'json'?");
    expect(() => validateOutputOptions({ flags: { format: true } })).toThrow("Option '--format' requires a value.");
    expect(() => validateOutputOptions({ options: { format: 'csv' } })).not.toThrow();
  });
});

describe('validateFieldSelection', () => {
  const data = { data: [{ token_symbol: 'X', value_usd: 1, token: { address: 'a' } }], pagination: { page: 1 } };

  it('accepts names present at any depth, dotted paths and documented returns', () => {
    expect(() => validateFieldSelection(data, ['token_symbol', 'address', 'data.token.address', 'pagination'])).not.toThrow();
    expect(() => validateFieldSelection({ data: [{ a: 1 }] }, ['price_usd'], { returns: ['price_usd'] })).not.toThrow();
  });

  it('rejects a dotted path that does not exist at that position', () => {
    expect(() => validateFieldSelection({ data: [{ token_symbol: 'ETH' }] }, ['results.token_symbol'])).toThrow(
      "Field 'results.token_symbol' is not in the response. Available fields: data, token_symbol",
    );
    expect(() => validateFieldSelection({ data: [{ token_symbol: 'ETH' }] }, ['data.token_symbol'])).not.toThrow();
  });

  it('finds a field that only a late row carries', () => {
    const rows = Array.from({ length: 500 }, (_, i) => (i === 499 ? { id: i, rare: true } : { id: i }));
    expect(() => validateFieldSelection({ data: rows }, ['rare'])).not.toThrow();
  });

  it('rejects a name that matches nothing, with the field list', () => {
    expect(() => validateFieldSelection(data, ['token_symbl'], { path: 'nansen research token screener' })).toThrow(
      expect.objectContaining({
        code: 'INVALID_PARAMS',
        message: "Field 'token_symbl' is not in the response from nansen research token screener. Available fields: data, token_symbol, value_usd, token, address, pagination, page",
      }),
    );
  });

  it('does not guess when the response has no rows', () => {
    expect(() => validateFieldSelection({}, ['anything'])).not.toThrow();
    expect(() => validateFieldSelection({ data: [], pagination: { page: 1 } }, ['address'], { returns: ['name'] })).not.toThrow();
  });

  it.each([40, 41])('labels a field list as partial only above 40 candidates (%i)', count => {
    const names = Array.from({ length: count }, (_, index) => `field_${index}`);
    const response = Object.fromEntries(names.map(name => [name, 1]));
    const listing = count > 40
      ? `Available fields (first 40 of 41): ${names.slice(0, 40).join(', ')}. Run without --fields to inspect the full response; see nansen schema for documented fields.`
      : `Available fields: ${names.join(', ')}`;
    expect(() => validateFieldSelection(response, ['unknown'])).toThrow(
      `Field 'unknown' is not in the response. ${listing}`,
    );
    // The display limit must not limit which fields can be selected.
    expect(() => validateFieldSelection(response, [names.at(-1)])).not.toThrow();
  });

  it('counts documented fields in the partial list and points to the schema', () => {
    const response = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field_${i}`, 1]));
    expect(() => validateFieldSelection(response, ['unknown'], { returns: ['documented_field'] })).toThrow(
      /Available fields \(first 40 of 41\): .*see nansen schema for documented fields\./,
    );
    expect(() => validateFieldSelection(response, ['documented_field'], { returns: ['documented_field'] })).not.toThrow();
  });
});

describe('normalizeFilterAddresses', () => {
  it('lowercases EVM addresses at any depth and leaves other values alone', () => {
    expect(normalizeFilterAddresses({
      token_address: EVM_MIXED,
      nested: { list: [EVM_MIXED, SOL_MINT] },
      label: 'Fund',
      amount: 5,
    })).toEqual({
      token_address: EVM,
      nested: { list: [EVM, SOL_MINT] },
      label: 'Fund',
      amount: 5,
    });
  });
});

// ============= Every research command =============

describe('schema-wide checks', () => {
  const leaves = researchLeaves();

  it('only marks list options on endpoints that have the matching request field', () => {
    const problems = [];
    for (const [words, leaf] of leaves) {
      const fields = API_ENDPOINTS[leaf.endpoint]?.fields;
      if (!fields) continue;
      const name = words.join(' ');
      if (leaf.options?.filters && !fields.includes('filters')) problems.push(`${name}: --filters but no filters field`);
      if (leaf.options?.sort && !fields.includes('order_by')) problems.push(`${name}: --sort but no order_by field`);
      if (leaf.pagination !== false && !fields.includes('pagination')) problems.push(`${name}: pagination allowed but no pagination field`);
    }
    expect(problems).toEqual([]);
  });

  // Every option the schema accepts must reach the request, and only through
  // fields the endpoint has (src/api-endpoints.json). An option that the
  // handler drops, or sends under a field the API does not know (which it
  // rejects with a 422), fails here.
  it.each(leaves.filter(([, leaf]) => leaf.endpoint && API_ENDPOINTS[leaf.endpoint]?.fields).flatMap(([words, leaf]) => Object.entries(leaf.options || {})
    .filter(([name, spec]) => !spec.required && !(name === 'as-of-date' && leaf.options['as-of-ts']))
    .map(([name, spec]) => [`${words.join(' ')} --${name}`, words, leaf, name, spec])))('%s is sent through a field the endpoint has', async (label, words, leaf, name, spec) => {
    const chainProbe = name === 'chain' || name === 'chains';
    const required = requiredArgs(leaf, { evmToken: chainProbe, skip: name === 'as-of-ts' ? ['as-of-date'] : [] });
    const baseline = await runCaptured([...words, ...required]);
    const probe = await runCaptured([...words, ...required, `--${name}`, probeValue(name, spec, leaf)]);
    expect(probe.exitCode, JSON.stringify(probe.output)).toBeNull();
    const fields = API_ENDPOINTS[leaf.endpoint].fields;
    const unknown = probe.calls.filter(call => call.endpoint === leaf.endpoint).flatMap(call => Object.keys(call.body).filter(key => !fields.includes(key)));
    expect(unknown, `${label} sends fields the endpoint does not have`).toEqual([]);
    if (!CLIENT_SIDE_OPTIONS.has(label)) {
      expect(JSON.stringify(probe.calls), `${label} is accepted but not sent`).not.toBe(JSON.stringify(baseline.calls));
    }
  });

  it('knows the chains of every endpoint that restricts --chain', () => {
    // The general search takes any chain name as free text.
    const freeText = new Set(['/api/v1/search/general']);
    const missing = leaves
      .filter(([, leaf]) => leaf.endpoint && (leaf.options?.chain || leaf.options?.chains) && !leaf.options?.chain?.enum)
      .filter(([, leaf]) => !freeText.has(leaf.endpoint) && !API_ENDPOINTS[leaf.endpoint]?.chains?.length)
      .map(([words]) => words.join(' '));
    expect(missing).toEqual([]);
  });

  it('documents supportedChains in `nansen schema`', () => {
    expect(SCHEMA.commands.research.subcommands.token.subcommands['flow-intelligence'].supportedChains).not.toContain('bitcoin');
    expect(SCHEMA.commands.research.subcommands.token.subcommands.holders.supportedChains).toContain('bitcoin');
  });

  const runnable = leaves.filter(([, leaf]) => leaf.endpoint);

  it.each(runnable.map(([words, leaf]) => [words.join(' '), words, leaf]))('%s runs with its required options and sends what it accepts', async (_name, words, leaf) => {
    const args = [...words, ...requiredArgs(leaf)];
    const probeFilters = leaf.options?.filters ? ['--filters', JSON.stringify({ probe_address: EVM_MIXED })] : [];
    const probeSort = leaf.options?.sort ? ['--sort', 'probe_field:asc'] : [];
    const probePages = leaf.pagination !== false ? ['--limit', '7', '--page', '2'] : [];
    const { calls, exitCode, output } = await runCaptured([...args, ...probeFilters, ...probeSort, ...probePages]);

    expect(exitCode, JSON.stringify(output)).toBeNull();
    const call = calls.find(c => c.endpoint === leaf.endpoint);
    expect(call, `no request to ${leaf.endpoint}`).toBeDefined();
    if (probeFilters.length) expect(call.body.filters?.probe_address).toBe(EVM);
    if (probeSort.length) expect(call.body.order_by).toEqual([{ field: 'probe_field', direction: 'ASC' }]);
    if (probePages.length && words.join(' ') !== 'research token screener') {
      expect(call.body.pagination).toEqual({ page: 2, per_page: 7 });
    }
  });

  // The request field is a list; a "a,b" string is rejected or misread by the API.
  const withChains = runnable.filter(([, leaf]) => leaf.options?.chains);

  it('has research commands with --chains to check', () => {
    expect(withChains.map(([words]) => words.join(' '))).toContain('research token screener');
  });

  it.each(withChains.flatMap(([words, leaf]) => {
    const [first, second] = supportedChainList(leaf) ?? ['ethereum', 'solana'];
    return [
      ['comma-separated', ['--chains', `${first},${second}`]],
      ['repeated', ['--chains', first, '--chains', second]],
      ['JSON array', ['--chains', JSON.stringify([first, second])]],
    ].map(([form, chainArgs]) => [words.join(' '), form, words, leaf, chainArgs, [first, second]]);
  }))('%s sends --chains (%s) as an array', async (_name, _form, words, leaf, chainArgs, expected) => {
    const { calls, exitCode, output } = await runCaptured([...words, ...requiredArgs(leaf), ...chainArgs]);
    expect(exitCode, JSON.stringify(output)).toBeNull();
    const call = calls.find(c => c.endpoint === leaf.endpoint);
    expect(call, `no request to ${leaf.endpoint}`).toBeDefined();
    expect(call.body.chains).toEqual(expected);
  });

  it.each(runnable
    .filter(([, leaf]) => supportedChainList(leaf))
    .map(([words, leaf]) => [words.join(' '), words, leaf]))('%s rejects an unsupported chain before any request', async (_name, words, leaf) => {
    const option = leaf.options.chain ? 'chain' : 'chains';
    const { calls, exitCode, output } = await runCaptured([...words, ...requiredArgs(leaf), `--${option}`, 'notachain']);
    expect(exitCode).toBe(1);
    expect(calls).toEqual([]);
    expect(output).toMatchObject({ success: false, code: 'INVALID_PARAMS', details: { param: `--${option}` } });
  });
});

function supportedChainList(leaf) {
  const spec = leaf.options?.chain ?? leaf.options?.chains;
  if (!spec) return null;
  return spec.enum ?? API_ENDPOINTS[leaf.endpoint]?.chains ?? null;
}

// ============= runCLI envelope =============

describe('runCLI failures always exit 1 with success:false (API-1080)', () => {
  it.each([
    [['research', 'token', 'scrrener']],
    [['token', 'scrrener', '--fields', 'token_symbol']],
    [['smart-money', 'netflw']],
    [['frobnicate']],
  ])('%j', async argv => {
    const { exitCode, output, calls } = await runCaptured(argv);
    expect(exitCode).toBe(1);
    expect(calls).toEqual([]);
    expect(output).toMatchObject({ success: false, code: 'UNKNOWN_COMMAND' });
  });

  it('rejects an unknown --fields name instead of printing {}', async () => {
    const { exitCode, output } = await runCaptured(['research', 'token', 'screener', '--fields', 'token_symbl']);
    expect(exitCode).toBe(1);
    expect(output).toMatchObject({
      success: false,
      code: 'INVALID_PARAMS',
      error: expect.stringMatching(/^Field 'token_symbl' is not in the response from nansen research token screener\. Available fields: /),
    });
  });

  it('still filters known --fields', async () => {
    const { exitCode, output } = await runCaptured(['research', 'token', 'screener', '--fields', 'token_symbol']);
    expect(exitCode).toBeNull();
    expect(output).toEqual({ success: true, data: { data: [{ token_symbol: 'X' }] } });
  });

  it('rejects --format xml before any request', async () => {
    const { exitCode, output, calls } = await runCaptured(['research', 'token', 'screener', '--format', 'xml']);
    expect(exitCode).toBe(1);
    expect(calls).toEqual([]);
    expect(output).toMatchObject({ success: false, code: 'INVALID_PARAMS', details: { param: '--format' } });
  });

  it('wires --limit/--page into profiler balance', async () => {
    const { calls } = await runCaptured(['research', 'profiler', 'balance', '--address', EVM, '--chain', 'ethereum', '--limit', '4', '--page', '2']);
    expect(calls[0].body.pagination).toEqual({ page: 2, per_page: 4 });
  });

  it('sends token screener --chains as a list, with aliases applied', async () => {
    const { calls, exitCode } = await runCaptured(['research', 'token', 'screener', '--chains', 'eth,SOL']);
    expect(exitCode).toBeNull();
    expect(calls[0].body.chains).toEqual(['ethereum', 'solana']);
  });

  it('sends the deprecated top-level token screener --chains as a list', async () => {
    const { calls, exitCode } = await runCaptured(['token', 'screener', '--chains', 'ethereum,solana']);
    expect(exitCode).toBeNull();
    expect(calls[0].body.chains).toEqual(['ethereum', 'solana']);
  });

  it('sends smart-money --labels as a list, comma-separated or repeated', async () => {
    const expected = ['Fund', 'Smart Trader'];
    for (const labelArgs of [['--labels', 'Fund,Smart Trader'], ['--labels', 'Fund', '--labels', 'Smart Trader']]) {
      const { calls, exitCode } = await runCaptured(['research', 'smart-money', 'netflow', ...labelArgs]);
      expect(exitCode).toBeNull();
      expect(calls[0].body.filters.include_smart_money_labels).toEqual(expected);
    }
  });

  it('splits repeated --addresses that carry a list themselves', async () => {
    const other = `0x${'11'.repeat(20)}`;
    const third = `0x${'22'.repeat(20)}`;
    const { calls, exitCode, output } = await runCaptured(['research', 'profiler', 'counterparties-batch', '--addresses', `${EVM},${other}`, '--addresses', third, '--chain', 'ethereum']);
    expect(exitCode, JSON.stringify(output)).toBeNull();
    expect(calls[0].body.wallet_addresses).toEqual([EVM, other, third]);
  });

  it.each([
    [['--sectors-filter', 'Crypto:AI,TradFi:Stocks'], 'sectors_filter', ['Crypto:AI', 'TradFi:Stocks']],
    [['--sm-label-filter', 'Fund,Smart Trader'], 'sm_label_filter', ['Fund', 'Smart Trader']],
    [['--trader-label-filter', 'HL Perps Whale,Other'], 'trader_label_filter', ['HL Perps Whale', 'Other']],
  ])('sends perp screener %j as a list', async (listArgs, field, expected) => {
    const { calls, exitCode, output } = await runCaptured(['research', 'perp', 'screener', ...listArgs]);
    expect(exitCode, JSON.stringify(output)).toBeNull();
    expect(calls[0].body.filters[field]).toEqual(expected);
  });

  it('sends prediction-market --tags as a list', async () => {
    const { calls, exitCode, output } = await runCaptured(['research', 'prediction-market', 'market-screener', '--tags', 'Politics,Sports']);
    expect(exitCode, JSON.stringify(output)).toBeNull();
    expect(calls[0].body.tags).toEqual(['Politics', 'Sports']);
  });

  it('wires --token into smart-money holdings as a lowercased filter', async () => {
    const { calls } = await runCaptured(['research', 'smart-money', 'holdings', '--chain', 'ethereum', '--token', EVM_MIXED]);
    expect(calls[0].body.filters).toEqual({ token_address: EVM });
  });

  it('lowercases mixed-case EVM addresses in --filters', async () => {
    const { calls } = await runCaptured(['research', 'token', 'transfers', '--chain', 'ethereum', '--token', EVM, '--filters', JSON.stringify({ from_address: EVM_MIXED })]);
    expect(calls[0].body.filters.from_address).toBe(EVM);
  });
});
