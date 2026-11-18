/**
 * The perp trading commands (order, close, cancel, leverage, transfer,
 * approve-builder-fee) sign and submit to Hyperliquid, so an option they do not
 * declare (a misspelled --dry-run) must be rejected before any request, wallet
 * lookup or signature, not dropped.
 *
 * The wallet, signing and submission seams are spies and global fetch throws,
 * so a rejected command that reached any of them fails the test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../wallet.js', async (importOriginal) => ({
  ...(await importOriginal()),
  showWallet: vi.fn(),
  getWalletConfig: vi.fn(() => ({})),
  exportWallet: vi.fn(),
}));

vi.mock('../keychain.js', () => ({
  retrievePassword: vi.fn(() => ({ password: null, source: null })),
}));

vi.mock('../hl-client.js', () => ({
  submitExchange: vi.fn(async () => ({ status: 'ok', response: { data: { statuses: [{ resting: { oid: 1 } }] } } })),
}));

vi.mock('../crypto.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, signSecp256k1: vi.fn(actual.signSecp256k1) };
});

import { exportWallet, showWallet } from '../wallet.js';
import { submitExchange } from '../hl-client.js';
import { signSecp256k1 } from '../crypto.js';
import { buildCommands } from '../cli.js';
import { validateDeclaredOptions } from '../input-validation.js';

const WALLET = '0x' + '1'.repeat(40);
const ETH = { name: 'ETH', asset_id: 1, sz_decimals: 4, max_leverage: 50 };

const COMMANDS = {
  order: { symbol: 'ETH', side: 'buy', size: '0.01', price: '2000', type: 'limit', wallet: 'x' },
  close: { symbol: 'ETH', side: 'sell', size: '0.01', price: '2000', wallet: 'x' },
  cancel: { symbol: 'ETH', oid: '4242', wallet: 'x' },
  leverage: { symbol: 'ETH', leverage: '5', wallet: 'x' },
  transfer: { direction: 'perp-to-spot', amount: '500', wallet: 'x' },
  'approve-builder-fee': { wallet: 'x' },
};

function mockApi() {
  return {
    request: vi.fn(async (endpoint) => {
      if (endpoint.startsWith('/api/v1/perp/meta')) return { assets: [ETH] };
      if (endpoint.startsWith('/api/v1/perp/builder-fee')) {
        return { approved: true, max_fee_rate: 80, required_fee: 80, builder_address: '0x' + 'ab'.repeat(20) };
      }
      if (endpoint.startsWith('/api/v1/perp/positions')) return { positions: [{ coin: 'ETH', szi: '0.02', entryPx: '1950' }] };
      if (endpoint.startsWith('/api/v1/perp/orders')) return { orders: [] };
      if (endpoint.startsWith('/api/v1/sanctions/screen')) return { results: [{ address: WALLET, sanctioned: false }] };
      throw new Error(`unexpected endpoint ${endpoint}`);
    }),
  };
}

let originalFetch;
beforeEach(() => {
  submitExchange.mockClear();
  signSecp256k1.mockClear();
  exportWallet.mockReset().mockReturnValue({ evm: { privateKey: '11'.repeat(32) } });
  showWallet.mockReset().mockReturnValue({ name: 'x', evm: WALLET, provider: 'local' });
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => {
    throw new Error('no network in this test');
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('perp trading commands reject undeclared options', () => {
  for (const [sub, options] of Object.entries(COMMANDS)) {
    it(`perp ${sub} --dryrun fails before any request, wallet lookup or signature`, async () => {
      const cmds = buildCommands({ log: () => {} });
      const api = mockApi();
      // `--dryrun` with no value parses as a flag.
      const err = await cmds.perp([sub], api, { dryrun: true }, { ...options }).catch(e => e);

      expect(err.code).toBe('INVALID_PARAMS');
      expect(err.details.errors).toEqual([{
        field: '--dryrun',
        code: 'unknown_field',
        message: expect.stringMatching(new RegExp(`^Option '--dryrun' is not recognized by nansen perp ${sub}\\. Did you mean '--dry-run'\\? Command-specific options: .*--dry-run`)),
      }]);
      expect(api.request).not.toHaveBeenCalled();
      expect(showWallet).not.toHaveBeenCalled();
      expect(signSecp256k1).not.toHaveBeenCalled();
      expect(submitExchange).not.toHaveBeenCalled();
    });
  }

  it('rejects an unknown option given a value, and lists every unknown option', async () => {
    const cmds = buildCommands({ log: () => {} });
    const err = await cmds.perp(['transfer'], mockApi(), {}, { ...COMMANDS.transfer, amout: '5', 'dry-rn': 'true' }).catch(e => e);
    expect(err.code).toBe('INVALID_PARAMS');
    expect(err.details.errors.map(e => e.field)).toEqual(['--amout', '--dry-rn']);
    expect(submitExchange).not.toHaveBeenCalled();
  });

  // `—dry-run` (an em dash, as autocorrect writes it) and a bare word are
  // positional arguments, not options; none of these commands takes one.
  for (const arg of ['—dry-run', 'dry-run', 'help']) {
    it(`perp transfer rejects the stray argument ${arg} before any request or signature`, async () => {
      const cmds = buildCommands({ log: () => {} });
      const api = mockApi();
      const err = await cmds.perp(['transfer', arg], api, {}, { ...COMMANDS.transfer }).catch(e => e);
      expect(err.code).toBe('INVALID_PARAMS');
      expect(err.details.errors).toEqual([{
        field: arg,
        code: 'unknown_field',
        message: expect.stringMatching(new RegExp(`^Argument '${arg}' is not recognized by nansen perp transfer: it takes no positional arguments, and options start with '--'\\..*--dry-run`)),
      }]);
      expect(api.request).not.toHaveBeenCalled();
      expect(showWallet).not.toHaveBeenCalled();
      expect(submitExchange).not.toHaveBeenCalled();
    });
  }

  it('perp approve-builder-fee help points at --help instead of signing', async () => {
    const cmds = buildCommands({ log: () => {} });
    const err = await cmds.perp(['approve-builder-fee', 'help'], mockApi(), {}, {}).catch(e => e);
    expect(err.code).toBe('INVALID_PARAMS');
    expect(err.details.errors[0].message).toContain('For help, run: nansen perp approve-builder-fee --help.');
    expect(showWallet).not.toHaveBeenCalled();
  });

  it('accepts declared options, their aliases (--coin, -y) and global options', async () => {
    const out = [];
    const cmds = buildCommands({ log: m => out.push(m) });
    const { symbol, ...rest } = COMMANDS.leverage;
    await cmds.perp(['leverage'], mockApi(), { 'dry-run': true, y: true, pretty: true, 'no-retry': true, paginate: true },
      { ...rest, coin: symbol, 'margin-type': 'cross', retries: '1', limit: '5', fields: 'x' });
    expect(out.join('\n')).toContain('Perp leverage plan — ETH');
    expect(submitExchange).not.toHaveBeenCalled();
  });

  it('leaves the read-only perp commands alone', async () => {
    const cmds = buildCommands({ log: () => {} });
    const err = await cmds.perp(['positions'], mockApi(), { dryrun: true }, { wallet: 'x' }).catch(e => e);
    expect(err?.code).not.toBe('INVALID_PARAMS');
  });
});

describe('validateDeclaredOptions', () => {
  const leaf = { options: { symbol: { type: 'string', aliases: ['coin'] }, yes: { type: 'boolean', aliases: ['y'] } } };
  const check = (flags, options) => () => validateDeclaredOptions({ path: 'nansen x', leaf }, { flags, options });

  it('accepts declared names, aliases, common and pagination options', () => {
    expect(check({ y: true, pretty: true, all: true }, { coin: 'BTC', limit: '5', 'cache-ttl': '0' })).not.toThrow();
  });

  it('ignores flags that are set false', () => {
    expect(check({ dryrun: false }, {})).not.toThrow();
  });

  it('names a one-letter unknown option with a single dash', () => {
    let err;
    try { check({ z: true }, {})(); } catch (e) { err = e; }
    expect(err.details.errors[0].field).toBe('-z');
    expect(err.details.errors[0].message).toBe(
      "Option '-z' is not recognized by nansen x. Command-specific options: --symbol, --yes. Common options also apply; see: nansen schema.",
    );
  });

  it('rejects positional arguments unless the leaf declares a positional option', () => {
    const run = (l, positional) => () => validateDeclaredOptions({ path: 'nansen x', leaf: l, positional }, {});
    expect(run(leaf, ['BTC'])).toThrow(/Argument 'BTC' is not recognized by nansen x/);
    expect(run(leaf, [])).not.toThrow();
    expect(run({ options: { address: { type: 'string', positional: true } } }, ['0xabc'])).not.toThrow();
  });

  it('leaves the option bags unchanged', () => {
    const flags = { y: true };
    const options = { coin: 'BTC' };
    check(flags, options)();
    expect(flags).toEqual({ y: true });
    expect(options).toEqual({ coin: 'BTC' });
  });
});
